import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  analyticsSnapshots,
  claims,
  contentItems,
  researchItems,
  sources,
} from '@/db/schema';
import { act, moveTo, verifyClaim } from './content';
import {
  AnalyticsError,
  awaitingMetrics,
  latestPerformance,
  previewReading,
  saveReading,
  seriesFor,
} from './analytics';
import {
  createContentItem,
  createOpportunity,
  scopedClaimsWithIds,
} from './opportunities';
import { submitForReview } from './qa';
import {
  confirmManualPublish,
  runDueJobs,
  scheduleItem,
} from './schedule';
import { createPublisherRegistry } from '@/adapters/publishers';
import type { Platform } from '@/domain/content';

let sqlite: Database.Database;
let db: DB;

const NOW = new Date('2026-09-21T12:00:00Z');
const SLOT = new Date('2026-09-21T13:00:00Z');

const registry = createPublisherRegistry('MANUAL');
const publisherFor = (p: Platform) => registry.for(p);

const INSTAGRAM_PANEL = `
Accounts reached
4,210
Likes
312
Comments
24
Saves
88
Shares
15
Follows
37
`;

/** Builds an item and takes it all the way to PUBLISHED. */
async function publishedItem(platform: Platform = 'INSTAGRAM'): Promise<number> {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  const researchItemId = db
    .insert(researchItems)
    .values({
      sourceId,
      title: 'A thing',
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;

  db.insert(claims)
    .values({ researchItemId, text: 'A thing happened.', claimType: 'FACT' })
    .run();

  const opportunityId = createOpportunity(db, {
    title: 'A thing',
    researchItemIds: [researchItemId],
  });

  const id = createContentItem(db, {
    opportunityId,
    platform,
    format: platform === 'INSTAGRAM' ? 'REEL' : 'TEXT',
  });

  for (const claim of scopedClaimsWithIds(db, id)) {
    verifyClaim(db, claim.id, {
      status: 'VERIFIED',
      evidenceUrl: 'https://example.com/e',
      evidenceTier: 'PRIMARY',
      verifiedBy: 'jatin',
    });
  }

  db.update(contentItems)
    .set({
      hook: 'Hook.',
      body: 'Body.',
      caption: 'Caption.',
      cta: 'Follow.',
      hashtags: 'ai',
      altText: 'Alt.',
    })
    .where(eq(contentItems.id, id))
    .run();

  moveTo(db, id, 'RESEARCHING');
  moveTo(db, id, 'RESEARCH_VERIFIED');
  moveTo(db, id, 'STRATEGY_READY');
  moveTo(db, id, 'GENERATING');
  moveTo(db, id, 'QA');
  submitForReview(db, id);
  act(db, id, 'APPROVE', { actor: 'jatin' });
  scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
  await runDueJobs(db, publisherFor, { now: SLOT });
  confirmManualPublish(db, {
    contentItemId: id,
    confirmedBy: 'jatin',
    now: SLOT,
  });

  return id;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('previewReading', () => {
  it('reads a panel without writing anything', async () => {
    const id = await publishedItem();
    const preview = previewReading(db, id, INSTAGRAM_PANEL);

    expect(preview.parsed.metrics.reach).toBe(4210);
    expect(preview.parsed.metrics.follows).toBe(37);
    // The confirm step is the whole reason OCR is acceptable under §40.
    expect(db.select().from(analyticsSnapshots).all()).toHaveLength(0);
  });

  it('flags a poor read as needing confirmation', async () => {
    const id = await publishedItem();
    expect(previewReading(db, id, 'Likes 12').needsConfirmation).toBe(true);
  });

  it('does not read a metric the platform never reports', async () => {
    const id = await publishedItem('LINKEDIN');
    const preview = previewReading(db, id, 'Saves 88\nLikes 12');
    expect(preview.parsed.metrics.saves).toBeUndefined();
  });
});

describe('saveReading — PRD §40', () => {
  it('stores only the metrics that were confirmed', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 4210, likes: 312 },
      source: 'OCR',
      confirmedBy: 'jatin',
      now: SLOT,
    });

    const row = db.select().from(analyticsSnapshots).all()[0];
    expect(row?.reach).toBe(4210);
    expect(row?.likes).toBe(312);
    // Absent, not zero. Different facts.
    expect(row?.saves).toBeNull();
    expect(row?.impressions).toBeNull();
  });

  it('refuses an OCR reading nobody confirmed', async () => {
    const id = await publishedItem();
    expect(() =>
      saveReading(db, {
        contentItemId: id,
        metrics: { reach: 4210 },
        source: 'OCR',
      }),
    ).toThrow(AnalyticsError);
  });

  it('accepts a manual reading without a confirmation name', async () => {
    const id = await publishedItem();
    expect(() =>
      saveReading(db, {
        contentItemId: id,
        metrics: { reach: 100 },
        source: 'MANUAL',
      }),
    ).not.toThrow();
  });

  it('refuses an empty reading rather than storing an empty row', async () => {
    const id = await publishedItem();
    expect(() =>
      saveReading(db, { contentItemId: id, metrics: {}, source: 'MANUAL' }),
    ).toThrow(/no metrics/);
  });

  it('refuses metrics for something that was never published', () => {
    // Storing these would corrupt every aggregate computed later.
    const id = db
      .insert(contentItems)
      .values({ platform: 'INSTAGRAM', format: 'REEL' })
      .returning({ id: contentItems.id })
      .get().id;

    expect(() =>
      saveReading(db, {
        contentItemId: id,
        metrics: { reach: 100 },
        source: 'MANUAL',
      }),
    ).toThrow(/no publication record/);
  });

  it('keeps the raw OCR text so a better parser can re-read it', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 4210 },
      source: 'OCR',
      rawText: INSTAGRAM_PANEL,
      confidence: 0.82,
      confirmedBy: 'jatin',
    });

    const row = db.select().from(analyticsSnapshots).all()[0];
    expect(row?.rawOcrText).toContain('Accounts reached');
    expect(row?.ocrConfidence).toBeCloseTo(0.82);
  });

  it('moves the item to ANALYZING on the first reading', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 100 },
      source: 'MANUAL',
    });
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('ANALYZING');
  });
});

describe('snapshots are a series, not a value', () => {
  it('appends rather than overwriting', async () => {
    const id = await publishedItem();

    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 500 },
      source: 'MANUAL',
      capturedAt: new Date('2026-09-21T18:00:00Z'),
    });
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 4210 },
      source: 'MANUAL',
      capturedAt: new Date('2026-09-22T18:00:00Z'),
    });

    // §29 needs the series; metrics move for days after publishing.
    const series = seriesFor(db, id);
    expect(series).toHaveLength(2);
    expect(series[0]?.reach).toBe(500);
    expect(series[1]?.reach).toBe(4210);
  });

  it('reports the latest reading, not a sum of readings', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 500, follows: 5 },
      source: 'MANUAL',
      capturedAt: new Date('2026-09-21T18:00:00Z'),
    });
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 4210, follows: 37 },
      source: 'MANUAL',
      capturedAt: new Date('2026-09-22T18:00:00Z'),
    });

    // Snapshots are cumulative, so summing them would double-count.
    const performance = latestPerformance(db);
    expect(performance).toHaveLength(1);
    expect(performance[0]?.reach).toBe(4210);
  });
});

describe('the north-star metric — PRD §27', () => {
  it('computes follows per 1,000 impressions', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { impressions: 10_000, follows: 25 },
      source: 'MANUAL',
    });
    expect(latestPerformance(db)[0]?.followsPerThousand).toBe(2.5);
  });

  it('falls back to reach when impressions were not reported', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 1_000, follows: 10 },
      source: 'MANUAL',
    });
    expect(latestPerformance(db)[0]?.followsPerThousand).toBe(10);
  });

  it('is null when follows were never reported', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { impressions: 10_000 },
      source: 'MANUAL',
    });
    // Unknown conversion is not zero conversion.
    expect(latestPerformance(db)[0]?.followsPerThousand).toBeNull();
  });
});

describe('awaitingMetrics', () => {
  it('lists published items with nothing captured yet', async () => {
    const id = await publishedItem();
    expect(awaitingMetrics(db).map((r) => r.id)).toEqual([id]);
  });

  it('drops an item once a reading exists', async () => {
    const id = await publishedItem();
    saveReading(db, {
      contentItemId: id,
      metrics: { reach: 100 },
      source: 'MANUAL',
    });
    expect(awaitingMetrics(db)).toHaveLength(0);
  });

  it('ignores items that were never published', async () => {
    await publishedItem();
    db.insert(contentItems)
      .values({ platform: 'INSTAGRAM', format: 'REEL', state: 'APPROVED' })
      .run();
    expect(awaitingMetrics(db)).toHaveLength(1);
  });
});

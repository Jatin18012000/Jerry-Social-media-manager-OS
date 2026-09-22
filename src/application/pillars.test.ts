import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { contentPillars, researchItemPillars, researchItems, sources } from '@/db/schema';
import {
  PillarError,
  addSecondaryPillar,
  listPillars,
  pillarCounts,
  pillarsForItems,
  removeSecondaryPillar,
  setPrimaryPillar,
} from './pillars';

let sqlite: Database.Database;
let db: DB;

function pillar(slug: string, name: string): number {
  return db
    .insert(contentPillars)
    .values({ slug, name })
    .returning({ id: contentPillars.id })
    .get().id;
}

function researchItem(title: string, primaryPillarId: number | null = null): number {
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

  return db
    .insert(researchItems)
    .values({
      sourceId,
      title,
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
      primaryPillarId,
    })
    .returning({ id: researchItems.id })
    .get().id;
}

let news: number;
let careers: number;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
  news = pillar('ai-news', 'AI News');
  careers = pillar('ai-careers', 'AI Careers');
});

describe('G — primary pillar may be NULL', () => {
  it('accepts a research item with no pillar', () => {
    const id = researchItem('Unclassifiable');
    expect(
      db.select().from(researchItems).where(eq(researchItems.id, id)).get()
        ?.primaryPillarId,
    ).toBeNull();
  });

  it('reports it as unclassified rather than as a pillar', () => {
    researchItem('Unclassifiable');
    researchItem('News item', news);

    const counts = pillarCounts(db);
    expect(counts.unclassified).toBe(1);
    // Never folded into a pillar: an unclassified item counted anywhere
    // would overstate that pillar's share.
    expect(counts.counts.reduce((n, c) => n + c.primaryCount, 0)).toBe(1);
  });

  it('can be cleared back to unclassified by a human', () => {
    // Correcting a wrong machine classification must allow "none of these"
    // rather than forcing the least wrong pillar.
    const id = researchItem('Wrongly classified', news);
    setPrimaryPillar(db, id, null);

    expect(pillarsForItems(db, [id]).get(id)?.primary).toBeNull();
  });
});

describe('J — unclassified research stays unclassified', () => {
  it('is not assigned a pillar by any read path', () => {
    const id = researchItem('Unclassifiable');

    expect(pillarsForItems(db, [id]).get(id)?.primary).toBeNull();
    expect(pillarsForItems(db, [id]).get(id)?.secondaries).toEqual([]);
  });

  it('is not given a fifth "other" pillar', () => {
    researchItem('Unclassifiable');
    // Only the pillars that exist are reported. Nothing invents a bucket.
    expect(pillarCounts(db).counts.map((c) => c.pillar.slug)).toEqual([
      'ai-news',
      'ai-careers',
    ]);
  });
});

describe('I — secondary pillars are human-controlled', () => {
  it('records who assigned each secondary', () => {
    const id = researchItem('Spans two pillars', news);
    addSecondaryPillar(db, { researchItemId: id, pillarId: careers, assignedBy: 'jatin' });

    const secondaries = pillarsForItems(db, [id]).get(id)?.secondaries ?? [];
    expect(secondaries).toHaveLength(1);
    expect(secondaries[0]?.assignedBy).toBe('jatin');
    expect(secondaries[0]?.slug).toBe('ai-careers');
  });

  it('refuses an unattributed assignment', () => {
    // No model and no heuristic writes these. If nobody is named, nobody
    // assigned it, and early pillar analytics is only worth having if it is
    // trustworthy.
    const id = researchItem('An item', news);
    expect(() =>
      addSecondaryPillar(db, { researchItemId: id, pillarId: careers, assignedBy: '  ' }),
    ).toThrow(PillarError);
    expect(db.select().from(researchItemPillars).all()).toHaveLength(0);
  });

  it('refuses a pillar that does not exist', () => {
    const id = researchItem('An item');
    expect(() =>
      addSecondaryPillar(db, { researchItemId: id, pillarId: 999, assignedBy: 'jatin' }),
    ).toThrow(PillarError);
  });

  it('refuses the item’s own primary pillar', () => {
    // "Also this pillar" cannot mean the one it is already primarily in;
    // allowing it would double-count the item.
    const id = researchItem('An item', news);
    expect(() =>
      addSecondaryPillar(db, { researchItemId: id, pillarId: news, assignedBy: 'jatin' }),
    ).toThrow(/already the primary/);
  });

  it('is idempotent', () => {
    const id = researchItem('An item', news);
    addSecondaryPillar(db, { researchItemId: id, pillarId: careers, assignedBy: 'jatin' });
    addSecondaryPillar(db, { researchItemId: id, pillarId: careers, assignedBy: 'jatin' });

    expect(db.select().from(researchItemPillars).all()).toHaveLength(1);
  });

  it('can be removed', () => {
    const id = researchItem('An item', news);
    addSecondaryPillar(db, { researchItemId: id, pillarId: careers, assignedBy: 'jatin' });
    removeSecondaryPillar(db, id, careers);

    expect(pillarsForItems(db, [id]).get(id)?.secondaries).toEqual([]);
  });

  it('refuses an item that does not exist', () => {
    expect(() =>
      addSecondaryPillar(db, { researchItemId: 999, pillarId: news, assignedBy: 'jatin' }),
    ).toThrow(PillarError);
  });
});

describe('setPrimaryPillar', () => {
  it('sets a pillar', () => {
    const id = researchItem('An item');
    setPrimaryPillar(db, id, news);
    expect(pillarsForItems(db, [id]).get(id)?.primary?.slug).toBe('ai-news');
  });

  it('refuses a pillar that does not exist', () => {
    const id = researchItem('An item');
    expect(() => setPrimaryPillar(db, id, 999)).toThrow(PillarError);
  });

  it('refuses an item that does not exist', () => {
    expect(() => setPrimaryPillar(db, 999, news)).toThrow(PillarError);
  });
});

describe('pillarCounts', () => {
  it('counts primary and secondary separately', () => {
    const a = researchItem('A', news);
    researchItem('B', news);
    addSecondaryPillar(db, { researchItemId: a, pillarId: careers, assignedBy: 'jatin' });

    const counts = pillarCounts(db);
    const newsRow = counts.counts.find((c) => c.pillar.slug === 'ai-news');
    const careersRow = counts.counts.find((c) => c.pillar.slug === 'ai-careers');

    expect(newsRow?.primaryCount).toBe(2);
    expect(careersRow?.primaryCount).toBe(0);
    expect(careersRow?.secondaryCount).toBe(1);
  });

  it('reports zero for a pillar with nothing in it', () => {
    expect(
      pillarCounts(db).counts.every((c) => c.primaryCount === 0),
    ).toBe(true);
  });
});

describe('listPillars', () => {
  it('returns the approved pillars', () => {
    expect(listPillars(db).map((p) => p.slug)).toEqual(['ai-news', 'ai-careers']);
  });
});

describe('pillarsForItems', () => {
  it('handles an empty request', () => {
    expect(pillarsForItems(db, []).size).toBe(0);
  });
});

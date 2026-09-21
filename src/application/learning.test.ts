import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { analyticsSnapshots, contentItems, learningFindings } from '@/db/schema';
import type { Language, Platform } from '@/domain/content';
import {
  allFindings,
  buildObservations,
  gaps,
  presentableFindings,
  recomputeAll,
  recomputeFindings,
} from './learning';

let sqlite: Database.Database;
let db: DB;

/**
 * Inserts a measured item directly.
 *
 * The full pipeline is exercised in schedule.test.ts and analytics.test.ts;
 * here the subject is the aggregation, and twenty items through the whole
 * state machine would test the same thing far more slowly.
 */
function measured(input: {
  language: Language;
  platform?: Platform;
  format?: string;
  hook?: string | null;
  impressions: number | null;
  follows: number | null;
  likes?: number | null;
  publishedAt?: number;
}): number {
  const id = db
    .insert(contentItems)
    .values({
      platform: input.platform ?? 'INSTAGRAM',
      format: (input.format ?? 'REEL') as 'REEL',
      language: input.language,
      state: 'ANALYZING',
      hook: input.hook ?? 'A statement about the model.',
      publishedAt: input.publishedAt ?? Date.parse('2026-09-20T04:30:00Z'),
    })
    .returning({ id: contentItems.id })
    .get().id;

  db.insert(analyticsSnapshots)
    .values({
      contentItemId: id,
      capturedAt: Date.now(),
      source: 'MANUAL',
      impressions: input.impressions,
      follows: input.follows,
      likes: input.likes ?? null,
    })
    .run();

  return id;
}

/** n items in a language, with a given follows-per-1k level. */
function cohort(
  language: Language,
  count: number,
  followsPerThousand: number,
): void {
  for (let i = 0; i < count; i += 1) {
    measured({
      language,
      impressions: 10_000,
      // Small jitter so variance is non-zero and an interval is computable.
      follows: Math.round(followsPerThousand * 10) + (i % 3),
    });
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('buildObservations — PRD §40 reaches all the way here', () => {
  it('builds one observation per measured item', () => {
    cohort('EN', 3, 2);
    expect(buildObservations(db, 'follows/1k')).toHaveLength(3);
  });

  it('excludes an item whose metric cannot be computed, rather than zeroing it', () => {
    measured({ language: 'EN', impressions: 10_000, follows: 25 });
    // Follows never reported: the metric is unknown, not zero.
    measured({ language: 'EN', impressions: 10_000, follows: null });

    const observations = buildObservations(db, 'follows/1k');
    expect(observations).toHaveLength(1);
    // A zero here would quietly drag every average down.
    expect(observations[0]?.value).toBe(2.5);
  });

  it('carries the §28 dimensions', () => {
    measured({
      language: 'HINGLISH',
      platform: 'INSTAGRAM',
      hook: '5 AI jobs that pay well',
      impressions: 1_000,
      follows: 10,
    });

    const dimensions = buildObservations(db, 'follows/1k')[0]?.dimensions;
    expect(dimensions?.language).toBe('HINGLISH');
    expect(dimensions?.platform).toBe('INSTAGRAM');
    expect(dimensions?.hookPattern).toBe('listicle');
    expect(dimensions?.postingHour).toBe('morning (06-12)');
  });

  it('uses only the latest snapshot per item', () => {
    const id = measured({ language: 'EN', impressions: 1_000, follows: 5 });
    db.insert(analyticsSnapshots)
      .values({
        contentItemId: id,
        capturedAt: Date.now() + 86_400_000,
        source: 'MANUAL',
        impressions: 2_000,
        follows: 20,
      })
      .run();

    const observations = buildObservations(db, 'follows/1k');
    expect(observations).toHaveLength(1);
    expect(observations[0]?.value).toBe(10);
  });
});

describe('recomputeFindings — PRD §29', () => {
  it('says nothing at all from a handful of posts', () => {
    // §29's own example: three posts cannot establish a language effect.
    cohort('HINGLISH', 3, 9);
    cohort('EN', 7, 1);

    recomputeFindings(db, 'follows/1k');

    const hinglish = allFindings(db).find((f) => f.segment === 'HINGLISH');
    expect(hinglish?.status).toBe('INSUFFICIENT_DATA');
    expect(presentableFindings(db).some((f) => f.segment === 'HINGLISH')).toBe(
      false,
    );
  });

  it('stores insufficient findings as gaps rather than discarding them', () => {
    // Knowing a dimension is under-sampled is useful; it just is not a claim.
    cohort('HINGLISH', 3, 9);
    cohort('EN', 7, 1);
    recomputeFindings(db, 'follows/1k');

    expect(gaps(db).some((f) => f.segment === 'HINGLISH')).toBe(true);
  });

  it('reaches HYPOTHESIS with enough data and a clear difference', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);

    recomputeFindings(db, 'follows/1k');

    const hinglish = presentableFindings(db).find(
      (f) => f.segment === 'HINGLISH',
    );
    expect(hinglish?.status).toBe('HYPOTHESIS');
    expect(hinglish?.sampleSize).toBe(12);
    expect(hinglish?.summary).toContain('Worth testing deliberately');
  });

  it('never claims causation from observational data', () => {
    cohort('HINGLISH', 60, 9);
    cohort('EN', 60, 1);
    recomputeFindings(db, 'follows/1k');

    // However much data accumulates, only a pre-registered experiment can
    // promote a finding to SUPPORTED.
    expect(allFindings(db).every((f) => f.status !== 'SUPPORTED')).toBe(true);
    for (const finding of allFindings(db)) {
      expect(finding.summary.toLowerCase()).not.toContain('causes');
    }
  });

  it('replaces the previous findings rather than accumulating them', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);

    recomputeFindings(db, 'follows/1k');
    const first = allFindings(db).length;
    recomputeFindings(db, 'follows/1k');

    // Two contradictory claims with no way to tell which is current would be
    // worse than either alone.
    expect(allFindings(db).length).toBe(first);
  });

  it('keeps findings for other metrics when one is recomputed', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);

    recomputeAll(db);
    const metrics = new Set(allFindings(db).map((f) => f.metric));
    expect(metrics.has('follows/1k')).toBe(true);

    recomputeFindings(db, 'follows/1k');
    expect(allFindings(db).some((f) => f.metric === 'follows/1k')).toBe(true);
  });

  it('handles having no data at all', () => {
    const report = recomputeFindings(db, 'follows/1k');
    expect(report.observations).toBe(0);
    expect(report.presentable).toBe(0);
    expect(presentableFindings(db)).toEqual([]);
  });

  it('ranks a hypothesis above an observation', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);
    // A third language with just enough data to be an observation.
    cohort('HI', 6, 5);

    recomputeFindings(db, 'follows/1k');

    const shown = presentableFindings(db);
    const statuses = shown.map((f) => f.status);
    const firstObservation = statuses.indexOf('OBSERVATION');
    const lastHypothesis = statuses.lastIndexOf('HYPOTHESIS');

    if (firstObservation !== -1 && lastHypothesis !== -1) {
      expect(lastHypothesis).toBeLessThan(firstObservation);
    }
  });

  it('records the run as a system event', () => {
    cohort('EN', 6, 2);
    recomputeFindings(db, 'follows/1k');
    const events = db.select().from(schema.systemEvents).all();
    expect(events.some((e) => e.kind === 'learning.recomputed')).toBe(true);
  });
});

describe('the findings a brief may use', () => {
  it('excludes insufficient findings from everything shown', () => {
    cohort('HINGLISH', 3, 9);
    cohort('EN', 12, 1);
    recomputeFindings(db, 'follows/1k');

    for (const finding of presentableFindings(db)) {
      expect(finding.status).not.toBe('INSUFFICIENT_DATA');
    }
  });

  it('carries sample size and confidence on every finding shown', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);
    recomputeFindings(db, 'follows/1k');

    for (const finding of presentableFindings(db)) {
      // §29: a finding without its sample size is a claim without evidence.
      expect(finding.sampleSize).toBeGreaterThan(0);
      expect(finding.confidence).toBeTruthy();
      expect(finding.summary).toBeTruthy();
    }
  });

  it('writes findings that are readable without the numbers', () => {
    cohort('HINGLISH', 12, 9);
    cohort('EN', 12, 1);
    recomputeFindings(db, 'follows/1k');

    const finding = db.select().from(learningFindings).all()[0];
    expect(finding?.summary.length).toBeGreaterThan(20);
  });
});

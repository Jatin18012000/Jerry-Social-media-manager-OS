/**
 * Analytics ingestion — PRD §26, §27, §28, §40, decision D4.
 *
 * The screenshot → OCR → confirm → database path, and the reads the learning
 * engine will sit on top of in M5.
 *
 * §40 governs everything here. A metric that was not read is absent, never
 * zero, and a low-confidence reading is never written without a human
 * confirming it — a confidently-wrong OCR read is fabricated data, and
 * fabricated data poisons the only input the learning engine has.
 */

import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  analyticsSnapshots,
  contentItems,
  publicationRecords,
  systemEvents,
} from '@/db/schema';
import type { Platform } from '@/domain/content';
import {
  type MetricKey,
  type ParsedMetrics,
  engagementRate,
  followsPerThousandImpressions,
  disallowedMetricsFor,
  needsConfirmation,
  parseMetrics,
} from '@/domain/metrics-parse';
import { moveTo } from './content';

export class AnalyticsError extends Error {}

export interface ReadingPreview {
  readonly contentItemId: number;
  readonly platform: Platform;
  readonly parsed: ParsedMetrics;
  readonly needsConfirmation: boolean;
  readonly rawText: string;
}

/**
 * Reads metrics out of OCR text without writing anything.
 *
 * Deliberately separate from persisting: the human sees what was understood
 * before it becomes data. That confirm step is the whole reason OCR is
 * acceptable under §40.
 */
export function previewReading(
  db: DB,
  contentItemId: number,
  rawText: string,
): ReadingPreview {
  const item = db
    .select({ platform: contentItems.platform, state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .get();

  if (!item) throw new AnalyticsError(`No content item ${contentItemId}`);

  const parsed = parseMetrics(rawText, item.platform);

  return {
    contentItemId,
    platform: item.platform,
    parsed,
    needsConfirmation: needsConfirmation(parsed),
    rawText,
  };
}

export interface SaveReadingInput {
  readonly contentItemId: number;
  /** Only the metrics the human confirmed. Anything absent stays absent. */
  readonly metrics: Partial<Record<MetricKey, number>>;
  readonly source: 'OCR' | 'MANUAL' | 'API';
  readonly rawText?: string;
  readonly confidence?: number;
  readonly screenshotPath?: string;
  readonly confirmedBy?: string;
  readonly capturedAt?: Date;
  readonly now?: Date;
}

/**
 * Persists a confirmed reading as a snapshot.
 *
 * Snapshots are append-only. Metrics move for days after publishing and §29's
 * analysis needs the series, so a later reading adds a row rather than
 * overwriting one.
 */
export function saveReading(db: DB, input: SaveReadingInput): number {
  const now = input.now ?? new Date();

  if (input.source === 'OCR' && !input.confirmedBy) {
    // §40: an OCR reading is a proposal until a person says otherwise.
    throw new AnalyticsError(
      'An OCR reading must be confirmed by a person before it is stored.',
    );
  }

  if (Object.keys(input.metrics).length === 0) {
    throw new AnalyticsError('There are no metrics to store.');
  }

  const item = db
    .select({ state: contentItems.state, platform: contentItems.platform })
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get();

  if (!item) {
    throw new AnalyticsError(`No content item ${input.contentItemId}`);
  }

  // A metric the platform does not report per post cannot be attributed to a
  // post here either. The OCR path is already filtered by the same list, so
  // this closes manual entry — otherwise account-level follower growth could
  // be typed against one post and become "evidence" it caused them.
  const disallowed = disallowedMetricsFor(
    item.platform,
    Object.keys(input.metrics) as MetricKey[],
  );

  if (disallowed.length > 0) {
    throw new AnalyticsError(
      `${item.platform} does not report ${disallowed.join(', ')} for an ` +
        `individual post, so it cannot be attributed to one. Account-level ` +
        `figures stay account-level.`,
    );
  }

  const published = db
    .select({ id: publicationRecords.id })
    .from(publicationRecords)
    .where(eq(publicationRecords.contentItemId, input.contentItemId))
    .get();

  if (!published) {
    // Metrics for something that was never published are meaningless, and
    // storing them would corrupt every aggregate computed later.
    throw new AnalyticsError(
      'This item has no publication record, so it has no metrics to capture.',
    );
  }

  const m = input.metrics;

  const snapshotId = db
    .insert(analyticsSnapshots)
    .values({
      contentItemId: input.contentItemId,
      capturedAt: (input.capturedAt ?? now).getTime(),
      source: input.source,
      // Every field is nullable and stays null when unread (§26, §40).
      impressions: m.impressions ?? null,
      reach: m.reach ?? null,
      views: m.views ?? null,
      likes: m.likes ?? null,
      comments: m.comments ?? null,
      saves: m.saves ?? null,
      shares: m.shares ?? null,
      profileVisits: m.profileVisits ?? null,
      follows: m.follows ?? null,
      watchTimeSeconds: m.watchTimeSeconds ?? null,
      clicks: m.clicks ?? null,
      rawOcrText: input.rawText ?? null,
      ocrConfidence: input.confidence ?? null,
      screenshotPath: input.screenshotPath ?? null,
      confirmedBy: input.confirmedBy ?? null,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    })
    .returning({ id: analyticsSnapshots.id })
    .get().id;

  db.insert(systemEvents)
    .values({
      kind: 'analytics.captured',
      severity: 'INFO',
      payload: JSON.stringify({
        contentItemId: input.contentItemId,
        source: input.source,
        metrics: Object.keys(m),
      }),
    })
    .run();

  // PUBLISHED -> ANALYZING on the first reading; ANALYZING -> ANALYZING on
  // later ones, which the state machine permits precisely for this.
  const state = db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get()?.state;

  if (state === 'PUBLISHED' || state === 'ANALYZING') {
    try {
      moveTo(db, input.contentItemId, 'ANALYZING', {
        actor: input.confirmedBy ?? 'analytics',
        note: `${input.source} reading`,
        now,
      });
    } catch {
      // The snapshot is already written and is the thing that matters. A
      // refused transition must not cost us the data.
    }
  }

  return snapshotId;
}

export interface ItemPerformance {
  readonly contentItemId: number;
  readonly platform: Platform;
  readonly format: string;
  readonly language: string;
  readonly capturedAt: number;
  readonly impressions: number | null;
  readonly reach: number | null;
  readonly follows: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly saves: number | null;
  readonly shares: number | null;
  /** §27 north star. Null when either input is missing. */
  readonly followsPerThousand: number | null;
  readonly engagementRatePct: number | null;
}

/**
 * The latest snapshot per published item.
 *
 * Latest rather than aggregated: a running total across snapshots of the same
 * item would double-count, since each snapshot is a cumulative reading rather
 * than a delta.
 */
export function latestPerformance(db: DB, limit = 50): ItemPerformance[] {
  const snapshots = db
    .select({
      contentItemId: analyticsSnapshots.contentItemId,
      capturedAt: analyticsSnapshots.capturedAt,
      impressions: analyticsSnapshots.impressions,
      reach: analyticsSnapshots.reach,
      follows: analyticsSnapshots.follows,
      likes: analyticsSnapshots.likes,
      comments: analyticsSnapshots.comments,
      saves: analyticsSnapshots.saves,
      shares: analyticsSnapshots.shares,
      platform: contentItems.platform,
      format: contentItems.format,
      language: contentItems.language,
    })
    .from(analyticsSnapshots)
    .innerJoin(contentItems, eq(contentItems.id, analyticsSnapshots.contentItemId))
    .orderBy(desc(analyticsSnapshots.capturedAt))
    .all();

  const seen = new Set<number>();
  const out: ItemPerformance[] = [];

  for (const row of snapshots) {
    if (seen.has(row.contentItemId)) continue;
    seen.add(row.contentItemId);

    out.push({
      contentItemId: row.contentItemId,
      platform: row.platform,
      format: row.format,
      language: row.language,
      capturedAt: row.capturedAt,
      impressions: row.impressions,
      reach: row.reach,
      follows: row.follows,
      likes: row.likes,
      comments: row.comments,
      saves: row.saves,
      shares: row.shares,
      followsPerThousand: followsPerThousandImpressions(
        row.follows,
        row.impressions ?? row.reach,
      ),
      engagementRatePct: engagementRate({
        likes: row.likes,
        comments: row.comments,
        saves: row.saves,
        shares: row.shares,
        reach: row.reach,
        impressions: row.impressions,
      }),
    });

    if (out.length >= limit) break;
  }

  return out;
}

/** Published items with no metrics captured yet — the capture worklist. */
export function awaitingMetrics(db: DB) {
  const captured = db
    .selectDistinct({ id: analyticsSnapshots.contentItemId })
    .from(analyticsSnapshots)
    .all()
    .map((r) => r.id);

  return db
    .select({
      id: contentItems.id,
      platform: contentItems.platform,
      format: contentItems.format,
      caption: contentItems.caption,
      publishedAt: contentItems.publishedAt,
      externalUrl: publicationRecords.externalUrl,
    })
    .from(contentItems)
    .innerJoin(
      publicationRecords,
      eq(publicationRecords.contentItemId, contentItems.id),
    )
    .where(
      and(
        isNotNull(contentItems.publishedAt),
        inArray(contentItems.state, ['PUBLISHED', 'ANALYZING', 'LEARNED']),
      ),
    )
    .orderBy(desc(contentItems.publishedAt))
    .all()
    .filter((row) => !captured.includes(row.id));
}

/** Every snapshot for one item, oldest first — the series §29 needs. */
export function seriesFor(db: DB, contentItemId: number) {
  return db
    .select()
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.contentItemId, contentItemId))
    .orderBy(analyticsSnapshots.capturedAt)
    .all();
}

/** Recent snapshots, for the dashboard. */
export function recentSnapshots(db: DB, sinceDays = 30) {
  const since = Date.now() - sinceDays * 86_400_000;
  return db
    .select()
    .from(analyticsSnapshots)
    .where(gte(analyticsSnapshots.capturedAt, since))
    .orderBy(desc(analyticsSnapshots.capturedAt))
    .all();
}

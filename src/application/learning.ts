/**
 * Learning engine wiring — PRD §28, §29, §67.
 *
 * Turns captured snapshots into observations, runs the analysis, and stores
 * the findings.
 *
 * The one rule that must survive this layer: an INSUFFICIENT_DATA finding is
 * never rendered as a conclusion. It is still *stored*, because knowing that a
 * dimension has too little data is itself useful and stops the same question
 * being re-asked — but everything that reads findings for display or for a
 * brief reads through `presentableFindings`.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  analyticsSnapshots,
  contentItems,
  contentPillars,
  learningFindings,
  systemEvents,
} from '@/db/schema';
import {
  type Finding,
  type Observation,
  analyseAll,
  hookPattern,
  postingSlot,
  presentable,
} from '@/domain/learning';
import {
  engagementRate,
  followsPerThousandImpressions,
} from '@/domain/metrics-parse';

/** The metrics the engine can analyse by. */
export const METRICS = {
  'follows/1k': 'follows per 1,000 impressions',
  'engagement%': 'engagement rate',
} as const;

export type MetricName = keyof typeof METRICS;

/**
 * Builds one observation per measured item.
 *
 * Uses the latest snapshot per item, and *excludes* items whose metric could
 * not be computed rather than substituting zero. §40's rule reaches all the
 * way here: a missing metric is missing, and feeding it in as zero would
 * quietly drag every average down.
 */
export function buildObservations(
  db: DB,
  metric: MetricName,
): Observation[] {
  const rows = db
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
      characterMode: contentItems.characterMode,
      pillarId: contentItems.pillarId,
      hook: contentItems.hook,
      publishedAt: contentItems.publishedAt,
    })
    .from(analyticsSnapshots)
    .innerJoin(
      contentItems,
      eq(contentItems.id, analyticsSnapshots.contentItemId),
    )
    .orderBy(desc(analyticsSnapshots.capturedAt))
    .all();

  const pillars = new Map(
    db
      .select({ id: contentPillars.id, name: contentPillars.name })
      .from(contentPillars)
      .all()
      .map((p) => [p.id, p.name]),
  );

  const seen = new Set<number>();
  const observations: Observation[] = [];

  for (const row of rows) {
    if (seen.has(row.contentItemId)) continue;
    seen.add(row.contentItemId);

    const value =
      metric === 'follows/1k'
        ? followsPerThousandImpressions(
            row.follows,
            row.impressions ?? row.reach,
          )
        : engagementRate({
            likes: row.likes,
            comments: row.comments,
            saves: row.saves,
            shares: row.shares,
            reach: row.reach,
            impressions: row.impressions,
          });

    // Excluded, not zeroed (§40).
    if (value === null) continue;

    observations.push({
      contentItemId: row.contentItemId,
      value,
      dimensions: {
        platform: row.platform,
        format: row.format,
        language: row.language,
        characterMode: row.characterMode,
        pillar: row.pillarId ? (pillars.get(row.pillarId) ?? null) : null,
        hookPattern: hookPattern(row.hook),
        postingHour: row.publishedAt
          ? postingSlot(new Date(row.publishedAt))
          : null,
      },
    });
  }

  return observations;
}

export interface RecomputeReport {
  readonly metric: MetricName;
  readonly observations: number;
  readonly findings: number;
  readonly presentable: number;
}

/**
 * Recomputes findings for one metric and replaces the stored set.
 *
 * Replace rather than append: a finding is a statement about all the data as
 * it stands now, and keeping yesterday's alongside today's would leave the
 * dashboard showing two contradictory claims with no way to tell which is
 * current.
 *
 * Experiment-derived findings are exempt from the replacement. A SUPPORTED
 * finding is the product of a pre-registered experiment (§30), not of this
 * recomputation, and it is the one status that cost something to obtain —
 * deleting it because new analytics arrived would throw away the only causal
 * knowledge the system has.
 */
export function recomputeFindings(
  db: DB,
  metric: MetricName,
  opts: { now?: Date } = {},
): RecomputeReport {
  const now = opts.now ?? new Date();
  const observations = buildObservations(db, metric);
  const findings = analyseAll(observations, metric);

  db.transaction((tx) => {
    tx.delete(learningFindings)
      .where(
        and(
          eq(learningFindings.metric, metric),
          isNull(learningFindings.experimentId),
        ),
      )
      .run();

    for (const finding of findings) {
      tx.insert(learningFindings)
        .values({
          dimension: finding.dimension,
          segment: finding.segment,
          metric: finding.metric,
          effectSize: finding.effectSize,
          sampleSize: finding.sampleSize,
          confidence: finding.confidence,
          status: finding.status,
          summary: finding.summary,
          computedAt: now.getTime(),
          createdAt: now.getTime(),
          updatedAt: now.getTime(),
        })
        .run();
    }
  });

  const shown = presentable(findings);

  db.insert(systemEvents)
    .values({
      kind: 'learning.recomputed',
      severity: 'INFO',
      payload: JSON.stringify({
        metric,
        observations: observations.length,
        findings: findings.length,
        presentable: shown.length,
      }),
    })
    .run();

  return {
    metric,
    observations: observations.length,
    findings: findings.length,
    presentable: shown.length,
  };
}

export function recomputeAll(db: DB, opts: { now?: Date } = {}) {
  return (Object.keys(METRICS) as MetricName[]).map((metric) =>
    recomputeFindings(db, metric, opts),
  );
}

/** Every stored finding, including the ones that say nothing. */
export function allFindings(db: DB) {
  return db
    .select()
    .from(learningFindings)
    .orderBy(desc(learningFindings.computedAt))
    .all();
}

/**
 * Findings that may be shown as something the system believes.
 *
 * §29: INSUFFICIENT_DATA is never rendered as a conclusion. Every display
 * path and every brief reads through this.
 */
export function presentableFindings(db: DB, limit = 20) {
  return db
    .select()
    .from(learningFindings)
    .where(
      inArray(learningFindings.status, [
        'SUPPORTED',
        'HYPOTHESIS',
        'OBSERVATION',
      ]),
    )
    .orderBy(desc(learningFindings.computedAt))
    .all()
    .sort((a, b) => {
      const rank = (s: string) =>
        s === 'SUPPORTED' ? 0 : s === 'HYPOTHESIS' ? 1 : 2;
      if (rank(a.status) !== rank(b.status)) {
        return rank(a.status) - rank(b.status);
      }
      return Math.abs(b.effectSize ?? 0) - Math.abs(a.effectSize ?? 0);
    })
    .slice(0, limit);
}

/** Dimensions that do not yet have enough data — useful, but not a claim. */
export function gaps(db: DB) {
  return db
    .select()
    .from(learningFindings)
    .where(eq(learningFindings.status, 'INSUFFICIENT_DATA'))
    .all();
}

export type { Finding };

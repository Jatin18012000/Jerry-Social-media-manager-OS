/**
 * Pillar classification for research — §10.
 *
 * Two different things, deliberately kept apart:
 *
 *   The **primary** pillar may be set by the classifier at ingestion, and
 *   edited by a human afterwards.
 *
 *   **Secondary** pillars are human-assigned only. No model and no heuristic
 *   writes them. Early pillar analytics is worth having only if it is
 *   trustworthy, and seeding it with machine guesses would corrupt the
 *   measurement it exists to enable. Every row records who assigned it.
 *
 * `NULL` primary means UNCLASSIFIED, and that is an outcome rather than a gap:
 * an item that fits none of the four pillars must not be pushed into the
 * nearest one (§7.1), and pillar counts exclude it rather than inventing a
 * category for it.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { contentPillars, researchItemPillars, researchItems } from '@/db/schema';

export class PillarError extends Error {}

export interface Pillar {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
}

export function listPillars(db: DB): Pillar[] {
  return db
    .select({
      id: contentPillars.id,
      slug: contentPillars.slug,
      name: contentPillars.name,
    })
    .from(contentPillars)
    .where(eq(contentPillars.active, true))
    .all();
}

function requirePillar(db: DB, pillarId: number): Pillar {
  const pillar = db
    .select({
      id: contentPillars.id,
      slug: contentPillars.slug,
      name: contentPillars.name,
    })
    .from(contentPillars)
    .where(eq(contentPillars.id, pillarId))
    .get();

  // Only the four approved pillars exist, and none may be invented here.
  if (!pillar) throw new PillarError(`No pillar ${pillarId}.`);
  return pillar;
}

function requireItem(db: DB, researchItemId: number): void {
  const item = db
    .select({ id: researchItems.id })
    .from(researchItems)
    .where(eq(researchItems.id, researchItemId))
    .get();

  if (!item) throw new PillarError(`No research item ${researchItemId}.`);
}

/**
 * Sets or clears the primary pillar on a research item.
 *
 * `null` clears it back to UNCLASSIFIED, which must stay reachable: a human
 * correcting a wrong machine classification needs to be able to say "none of
 * these" rather than being forced to pick the least wrong one.
 */
export function setPrimaryPillar(
  db: DB,
  researchItemId: number,
  pillarId: number | null,
): void {
  requireItem(db, researchItemId);
  if (pillarId !== null) requirePillar(db, pillarId);

  db.update(researchItems)
    .set({ primaryPillarId: pillarId })
    .where(eq(researchItems.id, researchItemId))
    .run();
}

/**
 * Adds a secondary pillar. Human-assigned only, and the assigner is recorded.
 *
 * Refuses the item's own primary pillar: "also this pillar" cannot mean the
 * one it is already primarily in, and allowing it would double-count the item
 * in pillar analytics.
 */
export function addSecondaryPillar(
  db: DB,
  input: { researchItemId: number; pillarId: number; assignedBy: string },
  opts: { now?: Date } = {},
): void {
  const assignedBy = input.assignedBy?.trim();
  if (!assignedBy) {
    throw new PillarError(
      'Secondary pillars are human-assigned, so the assigner must be named.',
    );
  }

  requireItem(db, input.researchItemId);
  requirePillar(db, input.pillarId);

  const item = db
    .select({ primaryPillarId: researchItems.primaryPillarId })
    .from(researchItems)
    .where(eq(researchItems.id, input.researchItemId))
    .get();

  if (item?.primaryPillarId === input.pillarId) {
    throw new PillarError(
      'That is already the primary pillar for this item.',
    );
  }

  const existing = db
    .select({ pillarId: researchItemPillars.pillarId })
    .from(researchItemPillars)
    .where(
      and(
        eq(researchItemPillars.researchItemId, input.researchItemId),
        eq(researchItemPillars.pillarId, input.pillarId),
      ),
    )
    .get();

  if (existing) return; // Idempotent; assigning twice is not an error.

  db.insert(researchItemPillars)
    .values({
      researchItemId: input.researchItemId,
      pillarId: input.pillarId,
      assignedBy,
      assignedAt: (opts.now ?? new Date()).getTime(),
    })
    .run();
}

export function removeSecondaryPillar(
  db: DB,
  researchItemId: number,
  pillarId: number,
): void {
  db.delete(researchItemPillars)
    .where(
      and(
        eq(researchItemPillars.researchItemId, researchItemId),
        eq(researchItemPillars.pillarId, pillarId),
      ),
    )
    .run();
}

export interface ItemPillars {
  readonly primary: Pillar | null;
  readonly secondaries: readonly (Pillar & { assignedBy: string })[];
}

/** Primary and secondary pillars for a set of items, in one pass. */
export function pillarsForItems(
  db: DB,
  researchItemIds: readonly number[],
): Map<number, ItemPillars> {
  const out = new Map<number, ItemPillars>();
  if (researchItemIds.length === 0) return out;

  const pillars = new Map(listPillars(db).map((p) => [p.id, p]));

  const primaries = db
    .select({
      id: researchItems.id,
      primaryPillarId: researchItems.primaryPillarId,
    })
    .from(researchItems)
    .where(inArray(researchItems.id, [...researchItemIds]))
    .all();

  const secondaries = db
    .select({
      researchItemId: researchItemPillars.researchItemId,
      pillarId: researchItemPillars.pillarId,
      assignedBy: researchItemPillars.assignedBy,
    })
    .from(researchItemPillars)
    .where(inArray(researchItemPillars.researchItemId, [...researchItemIds]))
    .all();

  const bySecondary = new Map<number, (Pillar & { assignedBy: string })[]>();
  for (const row of secondaries) {
    const pillar = pillars.get(row.pillarId);
    if (!pillar) continue;
    const list = bySecondary.get(row.researchItemId) ?? [];
    list.push({ ...pillar, assignedBy: row.assignedBy });
    bySecondary.set(row.researchItemId, list);
  }

  for (const row of primaries) {
    out.set(row.id, {
      primary:
        row.primaryPillarId === null
          ? null
          : (pillars.get(row.primaryPillarId) ?? null),
      secondaries: bySecondary.get(row.id) ?? [],
    });
  }

  return out;
}

export interface PillarCount {
  readonly pillar: Pillar;
  readonly primaryCount: number;
  readonly secondaryCount: number;
}

export interface PillarCounts {
  readonly counts: readonly PillarCount[];
  /**
   * Items with no primary pillar.
   *
   * Reported separately and never folded into a pillar: §29's habit of
   * distinguishing "we do not know" from a value applies to classification
   * too, and an unclassified item counted anywhere would overstate that
   * pillar's share.
   */
  readonly unclassified: number;
}

export function pillarCounts(db: DB): PillarCounts {
  const pillars = listPillars(db);

  const primary = db
    .select({
      pillarId: researchItems.primaryPillarId,
      count: sql<number>`count(*)`,
    })
    .from(researchItems)
    .groupBy(researchItems.primaryPillarId)
    .all();

  const secondary = db
    .select({
      pillarId: researchItemPillars.pillarId,
      count: sql<number>`count(*)`,
    })
    .from(researchItemPillars)
    .groupBy(researchItemPillars.pillarId)
    .all();

  const primaryBy = new Map(primary.map((r) => [r.pillarId, Number(r.count)]));
  const secondaryBy = new Map(
    secondary.map((r) => [r.pillarId, Number(r.count)]),
  );

  const unclassified = db
    .select({ count: sql<number>`count(*)` })
    .from(researchItems)
    .where(isNull(researchItems.primaryPillarId))
    .get();

  return {
    counts: pillars.map((pillar) => ({
      pillar,
      primaryCount: primaryBy.get(pillar.id) ?? 0,
      secondaryCount: secondaryBy.get(pillar.id) ?? 0,
    })),
    unclassified: Number(unclassified?.count ?? 0),
  };
}

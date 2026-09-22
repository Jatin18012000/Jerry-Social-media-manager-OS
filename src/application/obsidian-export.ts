/**
 * Projecting the database into an Obsidian vault — automation guide §10.
 *
 * §10 allows Obsidian as a human-readable knowledge layer and forbids it
 * becoming the only system of record. That is a one-way constraint, so this
 * is a one-way module: it reads the database and writes Markdown, and there
 * is deliberately no importer anywhere in the system. The database cannot
 * drift from the vault because the vault can never speak back.
 *
 * What that buys: the notes are disposable. Delete the vault folder, run the
 * export again, and nothing is lost. Anything Jatin writes *below* the
 * generated markers survives a re-export (see `mergeGenerated`), so the notes
 * are also a place to think — the one thing a projection usually cannot be.
 *
 * Every rule that governs how a fact is shown in the UI governs it here too.
 * §7.3 claim types stay distinct, §40's absent metric renders as an em-dash
 * and never a zero. A knowledge layer that quietly flattens either would be a
 * second, wrong account of what the system knows.
 */

import { desc, eq, inArray } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  claims,
  contentItems,
  contentOpportunities,
  contentPillars,
  opportunityResearch,
  publicationRecords,
  researchItems,
  sources,
} from '@/db/schema';
import {
  type OpportunityNote,
  type PublishedNote,
  type ResearchNote,
  notePath,
  renderOpportunityNote,
  renderPublishedNote,
  renderResearchNote,
} from '@/domain/obsidian';
import { type VaultWriter, FOLDERS } from '@/adapters/obsidian/vault-writer';
import { latestPerformance } from './analytics';

export class ExportError extends Error {}

export interface ExportReport {
  readonly vaultRoot: string;
  readonly created: number;
  readonly updated: number;
  readonly failed: readonly { path: string; reason: string }[];
  readonly byFolder: Readonly<Record<keyof typeof FOLDERS, number>>;
}

/** How many of each kind to project. The vault is a working set, not a mirror. */
export const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

function researchNotes(db: DB, limit: number): ResearchNote[] {
  const rows = db
    .select({
      id: researchItems.id,
      title: researchItems.title,
      summary: researchItems.summary,
      url: researchItems.url,
      publishedAt: researchItems.publishedAt,
      discoveredAt: researchItems.discoveredAt,
      relevanceScore: researchItems.relevanceScore,
      status: researchItems.status,
      sourceName: sources.name,
      credibilityTier: sources.credibilityTier,
    })
    .from(researchItems)
    .innerJoin(sources, eq(sources.id, researchItems.sourceId))
    .orderBy(desc(researchItems.discoveredAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const claimRows = db
    .select({
      researchItemId: claims.researchItemId,
      text: claims.text,
      claimType: claims.claimType,
      verificationStatus: claims.verificationStatus,
      evidenceUrl: claims.evidenceUrl,
      evidenceTier: claims.evidenceTier,
    })
    .from(claims)
    .where(inArray(claims.researchItemId, ids))
    .all();

  const byItem = new Map<number, ResearchNote['claims'][number][]>();
  for (const claim of claimRows) {
    const list = byItem.get(claim.researchItemId) ?? [];
    list.push(claim);
    byItem.set(claim.researchItemId, list);
  }

  return rows.map((row) => ({
    ...row,
    // Classification assigns a pillar but ingest does not persist it on the
    // research item, so there is nothing to render. Naming a plausible one
    // here would be inventing it (§7.1).
    pillarName: null,
    claims: byItem.get(row.id) ?? [],
  }));
}

function opportunityNotes(db: DB, limit: number): OpportunityNote[] {
  const rows = db
    .select({
      id: contentOpportunities.id,
      title: contentOpportunities.title,
      thesis: contentOpportunities.thesis,
      angle: contentOpportunities.angle,
      status: contentOpportunities.status,
      createdAt: contentOpportunities.createdAt,
      pillarName: contentPillars.name,
    })
    .from(contentOpportunities)
    .leftJoin(contentPillars, eq(contentPillars.id, contentOpportunities.pillarId))
    .orderBy(desc(contentOpportunities.createdAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const researchRows = db
    .select({
      opportunityId: opportunityResearch.opportunityId,
      id: researchItems.id,
      title: researchItems.title,
    })
    .from(opportunityResearch)
    .innerJoin(researchItems, eq(researchItems.id, opportunityResearch.researchItemId))
    .where(inArray(opportunityResearch.opportunityId, ids))
    .all();

  const variantRows = db
    .select({
      opportunityId: contentItems.opportunityId,
      id: contentItems.id,
      platform: contentItems.platform,
      format: contentItems.format,
      state: contentItems.state,
      topic: contentItems.topic,
    })
    .from(contentItems)
    .where(inArray(contentItems.opportunityId, ids))
    .all();

  const research = new Map<number, { id: number; title: string }[]>();
  for (const row of researchRows) {
    const list = research.get(row.opportunityId) ?? [];
    list.push({ id: row.id, title: row.title });
    research.set(row.opportunityId, list);
  }

  const variants = new Map<number, OpportunityNote['variants'][number][]>();
  for (const row of variantRows) {
    if (row.opportunityId === null) continue;
    const list = variants.get(row.opportunityId) ?? [];
    list.push({
      id: row.id,
      platform: row.platform,
      format: row.format,
      state: row.state,
      title: row.topic ?? 'Untitled',
    });
    variants.set(row.opportunityId, list);
  }

  return rows.map((row) => ({
    ...row,
    research: research.get(row.id) ?? [],
    variants: variants.get(row.id) ?? [],
  }));
}

function publishedNotes(db: DB, limit: number): PublishedNote[] {
  const rows = db
    .select({
      id: contentItems.id,
      topic: contentItems.topic,
      platform: contentItems.platform,
      format: contentItems.format,
      language: contentItems.language,
      characterMode: contentItems.characterMode,
      publishedAt: contentItems.publishedAt,
      hook: contentItems.hook,
      body: contentItems.body,
      caption: contentItems.caption,
      cta: contentItems.cta,
      hashtags: contentItems.hashtags,
      pillarName: contentPillars.name,
      opportunityId: contentOpportunities.id,
      opportunityTitle: contentOpportunities.title,
      externalUrl: publicationRecords.externalUrl,
    })
    .from(contentItems)
    .innerJoin(
      publicationRecords,
      eq(publicationRecords.contentItemId, contentItems.id),
    )
    .leftJoin(contentPillars, eq(contentPillars.id, contentItems.pillarId))
    .leftJoin(
      contentOpportunities,
      eq(contentOpportunities.id, contentItems.opportunityId),
    )
    .orderBy(desc(contentItems.publishedAt))
    .limit(limit)
    .all();

  // The same latest-per-item reading the analytics page uses, rather than a
  // second implementation that could disagree with it.
  const performance = new Map(
    latestPerformance(db, Number.MAX_SAFE_INTEGER).map((p) => [
      p.contentItemId,
      p,
    ]),
  );

  return rows.map((row) => {
    const perf = performance.get(row.id);
    return {
      id: row.id,
      title: row.topic ?? row.opportunityTitle ?? 'Untitled',
      platform: row.platform,
      format: row.format,
      language: row.language,
      characterMode: row.characterMode,
      publishedAt: row.publishedAt,
      externalUrl: row.externalUrl,
      hook: row.hook,
      body: row.body,
      caption: row.caption,
      cta: row.cta,
      hashtags: row.hashtags,
      pillarName: row.pillarName,
      opportunity:
        row.opportunityId === null
          ? null
          : { id: row.opportunityId, title: row.opportunityTitle ?? 'Untitled' },
      // Absent stays absent all the way into the note (§40). No snapshot
      // means "no metrics captured yet", not a row of zeroes.
      metrics: perf
        ? {
            impressions: perf.impressions,
            reach: perf.reach,
            likes: perf.likes,
            comments: perf.comments,
            saves: perf.saves,
            shares: perf.shares,
            follows: perf.follows,
            followsPerThousand: perf.followsPerThousand,
            engagementRatePct: perf.engagementRatePct,
            capturedAt: perf.capturedAt,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface PlannedNote {
  readonly folder: keyof typeof FOLDERS;
  readonly path: string;
  readonly markdown: string;
}

/**
 * Builds every note without touching the filesystem.
 *
 * Separated from the write so the whole projection can be asserted in tests
 * against no vault at all, and so a rendering bug cannot leave a vault half
 * written.
 */
export function planExport(db: DB, limit = DEFAULT_LIMIT): PlannedNote[] {
  const planned: PlannedNote[] = [];

  for (const note of researchNotes(db, limit)) {
    planned.push({
      folder: 'research',
      path: notePath(FOLDERS.research, note.id, note.title),
      markdown: renderResearchNote(note),
    });
  }

  for (const note of opportunityNotes(db, limit)) {
    planned.push({
      folder: 'opportunities',
      path: notePath(FOLDERS.opportunities, note.id, note.title),
      markdown: renderOpportunityNote(note),
    });
  }

  for (const note of publishedNotes(db, limit)) {
    planned.push({
      folder: 'published',
      path: notePath(FOLDERS.published, note.id, note.title),
      markdown: renderPublishedNote(note),
    });
  }

  return planned;
}

/**
 * Writes the projection into the vault.
 *
 * One failed note does not abandon the rest: a permission problem on a single
 * file is not a reason to leave the other 199 stale. Failures are collected
 * and reported, because a partial export that claimed success would be the
 * kind of quiet half-truth §40 exists to prevent.
 */
export async function exportToVault(
  db: DB,
  writer: VaultWriter,
  limit = DEFAULT_LIMIT,
): Promise<ExportReport> {
  const planned = planExport(db, limit);

  let created = 0;
  let updated = 0;
  const failed: { path: string; reason: string }[] = [];
  const byFolder: Record<keyof typeof FOLDERS, number> = {
    research: 0,
    opportunities: 0,
    published: 0,
  };

  for (const note of planned) {
    try {
      const outcome = await writer.write(note.path, note.markdown);
      if (outcome === 'CREATED') created += 1;
      else updated += 1;
      byFolder[note.folder] += 1;
    } catch (error) {
      failed.push({
        path: note.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { vaultRoot: writer.root, created, updated, failed, byFolder };
}

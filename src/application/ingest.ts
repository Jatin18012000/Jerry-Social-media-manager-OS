/**
 * Research ingestion — PRD §13 (RESEARCH → DISCOVERY), §14, §15, §16.
 *
 * One pass over one source: fetch, deduplicate, score, store, and propose
 * claim candidates with their provenance intact.
 *
 * Three rules shape this code more than anything else:
 *
 *   §7.1  Nothing here may invent verification. Every claim it writes is
 *         UNVERIFIED, and the database refuses a VERIFIED claim with no
 *         evidence, so there is no path by which ingestion can fabricate one.
 *   §7.4  A soft duplicate is recorded as a duplicate, not deleted. A wrongly
 *         discarded research item is invisible once discarded.
 *   §40   A failure is recorded as a failure. One bad source, or one bad item,
 *         does not fail the run or silently vanish.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { claims, researchItems, sources, systemEvents } from '@/db/schema';
import { extractClaimCandidates } from '@/domain/claim-extraction';
import {
  type DuplicateCandidate,
  canonicalUrl,
  classifyDuplicate,
  dedupeKey,
} from '@/domain/dedupe';
import type { FetchedItem, SourceFetcher, StructuredProvider } from '@/ports';
import { classifyResearchItem } from './classify';

export interface IngestReport {
  readonly sourceId: number;
  readonly sourceName: string;
  readonly fetched: number;
  readonly stored: number;
  readonly duplicates: number;
  readonly claimsProposed: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

/** How far back the soft-duplicate comparison looks. */
const DEDUPE_LOOKBACK_HOURS = 24 * 14;
const DEDUPE_CANDIDATE_LIMIT = 400;

function toDate(value: number | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

/**
 * Ingests one source.
 *
 * Each item is handled independently: a single malformed entry is counted as
 * a failure and the rest of the batch still lands. Losing a whole poll to one
 * bad row would mean a flaky source quietly starves the research queue.
 */
export async function ingestSource(
  db: DB,
  sourceId: number,
  fetcherFor: (kind: SourceFetcher['kind']) => SourceFetcher,
  opts: { now?: Date; classifier?: StructuredProvider | null } = {},
): Promise<IngestReport> {
  const now = opts.now ?? new Date();

  const source = db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId))
    .get();

  if (!source) {
    throw new Error(`Unknown source id ${sourceId}`);
  }

  const report = {
    sourceId,
    sourceName: source.name,
    fetched: 0,
    stored: 0,
    duplicates: 0,
    claimsProposed: 0,
    failed: 0,
    errors: [] as string[],
  };

  const fetcher = fetcherFor(source.fetcher);
  const target = source.feedUrl ?? source.url;

  let items: readonly FetchedItem[];
  try {
    const since = source.lastPolledAt
      ? new Date(source.lastPolledAt)
      : undefined;
    items = await fetcher.fetch({
      url: target,
      ...(since ? { since } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // §40: record the failure against the source. A source that has been
    // failing for a week should be visible as such, not silently quiet.
    db.update(sources)
      .set({ lastError: message, lastPolledAt: now.getTime() })
      .where(eq(sources.id, sourceId))
      .run();

    db.insert(systemEvents)
      .values({
        kind: 'source.fetch_failed',
        severity: 'ERROR',
        payload: JSON.stringify({ sourceId, source: source.name, message }),
      })
      .run();

    return { ...report, failed: 1, errors: [message] };
  }

  report.fetched = items.length;

  const recent: DuplicateCandidate[] = db
    .select({
      id: researchItems.id,
      title: researchItems.title,
      url: researchItems.url,
      publishedAt: researchItems.publishedAt,
    })
    .from(researchItems)
    .where(
      gte(
        researchItems.discoveredAt,
        now.getTime() - DEDUPE_LOOKBACK_HOURS * 3_600_000,
      ),
    )
    .orderBy(desc(researchItems.discoveredAt))
    .limit(DEDUPE_CANDIDATE_LIMIT)
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      publishedAt: toDate(row.publishedAt),
    }));

  for (const item of items) {
    try {
      const url = canonicalUrl(item.url);
      if (!url) {
        report.failed += 1;
        report.errors.push(`item "${item.title}" has no usable URL`);
        continue;
      }

      const verdict = classifyDuplicate(
        { title: item.title, url, publishedAt: item.publishedAt },
        recent,
      );

      // An exact URL match means we already hold this item. Nothing to store.
      if (verdict.reason === 'SAME_URL') {
        report.duplicates += 1;
        continue;
      }

      // Local model when it is running, deterministic heuristics when it is
      // not. Both paths are recorded in agent_runs (§43).
      const classification = await classifyResearchItem(
        db,
        { title: item.title, summary: item.summary },
        opts.classifier ?? null,
        { now },
      );

      const inserted = db
        .insert(researchItems)
        .values({
          sourceId,
          title: item.title,
          summary: item.summary ?? null,
          url,
          publishedAt: item.publishedAt?.getTime() ?? null,
          discoveredAt: now.getTime(),
          dedupeKey: dedupeKey(item.title),
          // A soft duplicate is stored and linked, never dropped (§7.4).
          duplicateOfId: verdict.isDuplicate ? (verdict.of ?? null) : null,
          relevanceScore: classification.relevance,
          status: verdict.isDuplicate ? 'DUPLICATE' : 'NEW',
          verificationStatus: 'UNVERIFIED',
        })
        .returning({ id: researchItems.id })
        .get();

      if (verdict.isDuplicate) {
        report.duplicates += 1;
      } else {
        report.stored += 1;
      }

      // Keep the in-memory candidate list current so duplicates *within* one
      // batch are caught too — a feed can carry the same story twice.
      recent.unshift({
        id: inserted.id,
        title: item.title,
        url,
        publishedAt: item.publishedAt,
      });

      // Claim candidates are only worth proposing for items we will act on.
      if (!verdict.isDuplicate) {
        const text = [item.summary, item.rawContent]
          .filter((t): t is string => Boolean(t))
          .join('\n\n');

        const candidates = extractClaimCandidates(text);

        for (const candidate of candidates) {
          db.insert(claims)
            .values({
              researchItemId: inserted.id,
              text: candidate.text,
              claimType: candidate.claimType,
              // §7.1: ingestion cannot verify anything, so it never claims to.
              verificationStatus: 'UNVERIFIED',
              note: `proposed by heuristic extractor (${candidate.signals.join(', ')})`,
            })
            .run();
          report.claimsProposed += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed += 1;
      report.errors.push(`${item.title}: ${message}`);
    }
  }

  db.update(sources)
    .set({ lastPolledAt: now.getTime(), lastError: null })
    .where(eq(sources.id, sourceId))
    .run();

  db.insert(systemEvents)
    .values({
      kind: 'source.ingested',
      severity: report.failed > 0 ? 'WARN' : 'INFO',
      payload: JSON.stringify(report),
    })
    .run();

  return report;
}

/** Sources whose poll interval has elapsed. */
export function dueSources(db: DB, now: Date = new Date()): number[] {
  return db
    .select({
      id: sources.id,
      lastPolledAt: sources.lastPolledAt,
      pollIntervalMinutes: sources.pollIntervalMinutes,
    })
    .from(sources)
    .where(eq(sources.enabled, true))
    .all()
    .filter((row) => {
      if (row.lastPolledAt === null) return true;
      const dueAt = row.lastPolledAt + row.pollIntervalMinutes * 60_000;
      return now.getTime() >= dueAt;
    })
    .map((row) => row.id);
}

/** Ingests every due source, one at a time to stay polite to publishers. */
export async function ingestDueSources(
  db: DB,
  fetcherFor: (kind: SourceFetcher['kind']) => SourceFetcher,
  opts: { now?: Date; classifier?: StructuredProvider | null } = {},
): Promise<IngestReport[]> {
  const now = opts.now ?? new Date();
  const reports: IngestReport[] = [];

  for (const sourceId of dueSources(db, now)) {
    reports.push(
      await ingestSource(db, sourceId, fetcherFor, {
        now,
        classifier: opts.classifier ?? null,
      }),
    );
  }

  return reports;
}

/**
 * Ingests a single URL a human pasted — decision D5's escape hatch.
 *
 * Routed through the same pipeline as a feed item so that a manually added
 * story gets the same dedupe, scoring, claim proposal and provenance as an
 * automatically discovered one.
 */
export async function ingestManualUrl(
  db: DB,
  url: string,
  fetcher: SourceFetcher,
  opts: {
    now?: Date;
    sourceName?: string;
    classifier?: StructuredProvider | null;
  } = {},
): Promise<IngestReport> {
  const now = opts.now ?? new Date();

  // One standing source row represents everything added by hand, so manual
  // items are attributable and countable like any other source.
  let manual = db
    .select()
    .from(sources)
    .where(eq(sources.fetcher, 'MANUAL'))
    .get();

  if (!manual) {
    const id = db
      .insert(sources)
      .values({
        name: opts.sourceName ?? 'Manual additions',
        type: 'MANUAL',
        fetcher: 'MANUAL',
        url: 'about:manual',
        // §7.2: a pasted link inherits no authority from the act of pasting.
        credibilityTier: 'OTHER',
        pollIntervalMinutes: 0,
      })
      .returning({ id: sources.id })
      .get();
    manual = db.select().from(sources).where(eq(sources.id, id.id)).get()!;
  }

  // The manual fetcher reads the one URL given, ignoring the source row's own.
  const scoped: SourceFetcher = {
    name: fetcher.name,
    kind: fetcher.kind,
    fetch: () => fetcher.fetch({ url }),
  };

  return ingestSource(db, manual.id, () => scoped, {
    now,
    classifier: opts.classifier ?? null,
  });
}

/** Research items awaiting triage, most relevant first. */
export function triageQueue(db: DB, limit = 50) {
  return db
    .select()
    .from(researchItems)
    .where(
      and(
        inArray(researchItems.status, ['NEW', 'TRIAGED']),
        eq(researchItems.verificationStatus, 'UNVERIFIED'),
      ),
    )
    .orderBy(desc(researchItems.relevanceScore), desc(researchItems.discoveredAt))
    .limit(limit)
    .all();
}

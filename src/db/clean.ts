/**
 * Removes demo and test data from a development database.
 *
 * `db:demo` and manual verification runs leave behind research items,
 * opportunities, content, publications, analytics and experiments that look
 * exactly like real work on every screen. Once there is real work, telling
 * the two apart by eye stops being possible — so this exists to be run before
 * that point, not after.
 *
 * **What it keeps**, because it is configuration rather than demo data:
 *
 *   The §10 content pillars. They are seeded, but they are also editable, and
 *   re-seeding deliberately does not clobber an edited name.
 *
 *   The §14 source list, identified by URL against `SEED_SOURCE_URLS` rather
 *   than by row id — ids shift the moment anything is inserted or deleted,
 *   and a cleanup that deletes the wrong row because an id moved is worse
 *   than no cleanup. Sources outside that list were invented by demo runs.
 *
 *   The brand configuration, unless `--brand` is passed. §4 makes brand voice
 *   Jatin's and ChatGPT's deliverable; if a real one has been written, losing
 *   it to a cleanup script would destroy work this repository cannot
 *   regenerate. A non-placeholder config is reported instead, so a fabricated
 *   one can be removed deliberately.
 *
 * Everything else is operational state and goes.
 *
 * Never run against a production database — there is no production database,
 * and by D2 there is not going to be one, but the warning stands.
 */

import { notInArray } from 'drizzle-orm';

import { createDb } from './client';
import {
  agentRuns,
  analyticsSnapshots,
  approvalEvents,
  brandConfig,
  briefs,
  claims,
  contentExperiments,
  contentItemSources,
  contentItems,
  contentOpportunities,
  contentPillars,
  costRecords,
  experiments,
  generations,
  learningFindings,
  mediaAssets,
  notifications,
  opportunityResearch,
  publicationRecords,
  researchItems,
  scheduleJobs,
  sources,
  systemEvents,
} from './schema';
import { SEED_SOURCE_URLS } from './seed';

export interface CleanReport {
  readonly deleted: Readonly<Record<string, number>>;
  readonly total: number;
  readonly sourcesKept: number;
  readonly pillarsKept: number;
  /**
   * Set when a brand configuration was found that is not the placeholder and
   * was left alone. §4 says where a real one comes from, and it is not here.
   */
  readonly brandConfigKept: string | null;
  readonly brandConfigDeleted: boolean;
}

export interface CleanOptions {
  /** Also remove the brand configuration. Off by default, deliberately. */
  readonly brand?: boolean;
}

export function clean(
  databaseUrl = process.env['DATABASE_URL'] ?? './data/os.db',
  opts: CleanOptions = {},
): CleanReport {
  const db = createDb(databaseUrl);
  const deleted: Record<string, number> = {};

  const record = (table: string, rows: { changes: number }) => {
    if (rows.changes > 0) deleted[table] = rows.changes;
  };

  // Children before parents. Foreign keys are ON, so a wrong order fails
  // loudly inside the transaction rather than leaving a half-cleaned database.
  db.transaction((tx) => {
    record('notifications', tx.delete(notifications).run());
    record('cost_records', tx.delete(costRecords).run());
    record('agent_runs', tx.delete(agentRuns).run());
    record('generations', tx.delete(generations).run());
    record('briefs', tx.delete(briefs).run());
    record('media_assets', tx.delete(mediaAssets).run());
    record('system_events', tx.delete(systemEvents).run());

    record('learning_findings', tx.delete(learningFindings).run());
    record('content_experiments', tx.delete(contentExperiments).run());
    record('experiments', tx.delete(experiments).run());

    record('analytics_snapshots', tx.delete(analyticsSnapshots).run());
    record('publication_records', tx.delete(publicationRecords).run());
    record('schedule_jobs', tx.delete(scheduleJobs).run());

    record('approval_events', tx.delete(approvalEvents).run());
    record('content_item_sources', tx.delete(contentItemSources).run());
    record('content_items', tx.delete(contentItems).run());

    record('opportunity_research', tx.delete(opportunityResearch).run());
    record('content_opportunities', tx.delete(contentOpportunities).run());

    record('claims', tx.delete(claims).run());
    record('research_items', tx.delete(researchItems).run());

    // Only the sources a demo run invented. The §14 list stays.
    record(
      'sources',
      tx.delete(sources).where(notInArray(sources.url, [...SEED_SOURCE_URLS])).run(),
    );
  });

  const kept = db.select({ url: sources.url }).from(sources).all();
  const pillarsKept = db
    .select({ id: contentPillars.id })
    .from(contentPillars)
    .all().length;

  const brand = db.select().from(brandConfig).all();
  let brandConfigKept: string | null = null;
  let brandConfigDeleted = false;

  if (brand.length > 0) {
    if (opts.brand) {
      db.delete(brandConfig).run();
      brandConfigDeleted = true;
      deleted['brand_config'] = brand.length;
    } else {
      const names = brand
        .map((row) => {
          try {
            const payload = JSON.parse(row.payloadJson) as {
              brandName?: string;
              isPlaceholder?: boolean;
            };
            return payload.isPlaceholder
              ? null
              : (payload.brandName ?? 'unnamed');
          } catch {
            return 'unreadable';
          }
        })
        .filter((name): name is string => name !== null);

      brandConfigKept = names.length > 0 ? names.join(', ') : null;
    }
  }

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);

  return {
    deleted,
    total,
    sourcesKept: kept.length,
    pillarsKept,
    brandConfigKept,
    brandConfigDeleted,
  };
}

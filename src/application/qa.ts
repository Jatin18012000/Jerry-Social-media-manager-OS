/**
 * The QA gate — PRD §13, §22.
 *
 * Runs between GENERATING and READY_FOR_REVIEW. Blockers keep an item out of
 * the review queue; warnings travel with it so the reviewer sees them but is
 * not stopped by them.
 */

import { eq } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { contentItems, systemEvents } from '@/db/schema';
import { type QaReport, runQa } from '@/domain/qa';
import { createInAppNotifier } from '@/adapters/notifiers/in-app-notifier';
import { activeBrand, scopedClaims } from './opportunities';
import { moveTo } from './content';

export function qaFor(db: DB, contentItemId: number): QaReport {
  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .get();

  if (!item) throw new Error(`No content item ${contentItemId}`);

  const claims = scopedClaims(db, contentItemId).map((claim) => ({
    claimType: claim.claimType,
    verificationStatus: claim.verificationStatus,
  }));

  return runQa({
    platform: item.platform,
    format: item.format,
    language: item.language,
    characterMode: item.characterMode,
    hook: item.hook,
    body: item.body,
    caption: item.caption,
    cta: item.cta,
    hashtags: item.hashtags,
    altText: item.altText,
    claims,
    brandIsPlaceholder: activeBrand(db).isPlaceholder,
  });
}

export interface SubmitForReviewResult {
  readonly ok: boolean;
  readonly report: QaReport;
}

/**
 * Runs QA and, if it passes, moves the item into the review queue.
 *
 * A failing gate routes to NEEDS_REVISION rather than leaving the item in QA,
 * so nothing sits in a state nobody looks at.
 */
export function submitForReview(
  db: DB,
  contentItemId: number,
  opts: { actor?: string; now?: Date } = {},
): SubmitForReviewResult {
  const report = qaFor(db, contentItemId);

  db.insert(systemEvents)
    .values({
      kind: 'qa.run',
      severity: report.passed ? 'INFO' : 'WARN',
      payload: JSON.stringify({ contentItemId, findings: report.findings }),
    })
    .run();

  const note = report.passed
    ? report.warnings.length > 0
      ? `QA passed with ${report.warnings.length} warning(s)`
      : 'QA passed'
    : `QA blocked: ${report.blockers.map((b) => b.code).join(', ')}`;

  if (report.passed) {
    const item = db
      .select({
        platform: contentItems.platform,
        format: contentItems.format,
      })
      .from(contentItems)
      .where(eq(contentItems.id, contentItemId))
      .get();

    createInAppNotifier(db).notifySync({
      kind: 'CONTENT_READY_FOR_REVIEW',
      title: `${item?.platform} ${item?.format} is ready for review`,
      body:
        report.warnings.length > 0
          ? `QA passed with ${report.warnings.length} warning(s).`
          : 'QA passed with no warnings.',
      contentItemId,
      // One notification per item, refreshed if it comes back round.
      dedupeKey: `review:${contentItemId}`,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  moveTo(db, contentItemId, report.passed ? 'READY_FOR_REVIEW' : 'NEEDS_REVISION', {
    ...(opts.actor !== undefined ? { actor: opts.actor } : { actor: 'qa' }),
    note,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  return { ok: report.passed, report };
}

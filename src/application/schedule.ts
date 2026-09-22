/**
 * Scheduling and publishing — PRD §24, §39, §40, decisions D1 and D2.
 *
 * The §39 guarantee is the reason this module is careful: a content item must
 * never be published twice because a worker retried. Four layers stand in the
 * way, and they are independent on purpose:
 *
 *   1. UNIQUE(idempotency_key) on schedule_jobs — one job per item/platform/slot
 *   2. An atomic conditional UPDATE to claim a job, so two runners cannot both
 *      take it
 *   3. UNIQUE(content_item_id, platform) on publication_records — the database
 *      refuses a second publication whatever the application believes
 *   4. The domain state machine, which will not enter PUBLISHED without
 *      publication evidence
 *
 * A double publish is not recoverable, so it is worth four locks.
 */

import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  contentItems,
  publicationRecords,
  scheduleJobs,
  systemEvents,
} from '@/db/schema';
import type { Platform } from '@/domain/content';
import {
  type SchedulableJob,
  decideJob,
  idempotencyKey,
  retryDelayMs,
  validateScheduleTime,
} from '@/domain/schedule';
import type { PublishRequest, Publisher } from '@/ports';
import { createInAppNotifier } from '@/adapters/notifiers/in-app-notifier';
import { moveTo } from './content';

export class ScheduleError extends Error {}

export interface ScheduleInput {
  readonly contentItemId: number;
  readonly runAt: Date;
  readonly timezone?: string;
  readonly graceWindowMinutes?: number;
  readonly actor?: string;
  readonly now?: Date;
}

/**
 * Schedules an approved content item — §24.
 *
 * The state move to SCHEDULED is delegated to the domain, which permits it
 * only from APPROVED. That is §22's human gate, and this module does not get
 * to make an exception to it.
 */
export function scheduleItem(db: DB, input: ScheduleInput): number {
  const now = input.now ?? new Date();

  const validity = validateScheduleTime(input.runAt, now);
  if (!validity.ok) throw new ScheduleError(validity.reason);

  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get();

  if (!item) throw new ScheduleError(`No content item ${input.contentItemId}`);

  const key = idempotencyKey(item.id, item.platform, input.runAt);

  const existing = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.idempotencyKey, key))
    .get();

  // Re-scheduling the same item to the same slot is a no-op, not an error:
  // a double-submitted form should not produce a second job.
  if (existing) return existing.id;

  const jobId = db
    .insert(scheduleJobs)
    .values({
      contentItemId: item.id,
      runAt: input.runAt.getTime(),
      timezone: input.timezone ?? 'Asia/Kolkata',
      status: 'PENDING',
      graceWindowMinutes: input.graceWindowMinutes ?? 30,
      idempotencyKey: key,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    })
    .returning({ id: scheduleJobs.id })
    .get().id;

  moveTo(db, item.id, 'SCHEDULED', {
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    note: `scheduled for ${input.runAt.toISOString()}`,
    patch: { scheduledAt: input.runAt.getTime() },
    now,
  });

  return jobId;
}

/** Cancels a scheduled job and returns the item to APPROVED — §23 Unschedule. */
export function unscheduleItem(
  db: DB,
  contentItemId: number,
  opts: { actor?: string; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();

  db.update(scheduleJobs)
    .set({ status: 'CANCELLED', updatedAt: now.getTime() })
    .where(
      and(
        eq(scheduleJobs.contentItemId, contentItemId),
        inArray(scheduleJobs.status, ['PENDING', 'MISSED']),
      ),
    )
    .run();

  moveTo(db, contentItemId, 'APPROVED', {
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    note: 'unscheduled',
    patch: { scheduledAt: null },
    now,
  });
}

/**
 * Claims a job for this runner.
 *
 * The conditional UPDATE is the concurrency guard: only one caller can move a
 * job out of an unlocked state, because SQLite serialises the write. A
 * check-then-update would leave a window in which two runners both see it
 * unlocked.
 */
function claimJob(db: DB, jobId: number, now: Date, lockStaleMs: number): boolean {
  const result = db
    .update(scheduleJobs)
    .set({ lockedAt: now.getTime(), status: 'RUNNING', updatedAt: now.getTime() })
    .where(
      and(
        eq(scheduleJobs.id, jobId),
        inArray(scheduleJobs.status, ['PENDING', 'RUNNING']),
        or(
          isNull(scheduleJobs.lockedAt),
          lte(scheduleJobs.lockedAt, now.getTime() - lockStaleMs),
        ),
      ),
    )
    .run();

  return result.changes > 0;
}

export interface RunReport {
  readonly considered: number;
  readonly published: number;
  readonly awaitingHuman: number;
  readonly missed: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Runs every job that is due.
 *
 * A job whose window has passed by more than its grace period is marked
 * MISSED and surfaced, never fired — see decision D2 and the note in
 * domain/schedule.ts.
 */
export async function runDueJobs(
  db: DB,
  publisherFor: (platform: Platform) => Publisher,
  opts: { now?: Date; lockStaleMinutes?: number } = {},
): Promise<RunReport> {
  const now = opts.now ?? new Date();
  const lockStaleMs = (opts.lockStaleMinutes ?? 15) * 60_000;

  const candidates = db
    .select()
    .from(scheduleJobs)
    .where(
      and(
        inArray(scheduleJobs.status, ['PENDING', 'RUNNING']),
        lte(scheduleJobs.runAt, now.getTime()),
      ),
    )
    .orderBy(asc(scheduleJobs.runAt))
    .all();

  const report = {
    considered: candidates.length,
    published: 0,
    awaitingHuman: 0,
    missed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of candidates) {
    const job: SchedulableJob = {
      id: row.id,
      runAt: row.runAt,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      graceWindowMinutes: row.graceWindowMinutes,
      lockedAt: row.lockedAt,
    };

    const decision = decideJob(job, now, {
      lockStaleMinutes: opts.lockStaleMinutes ?? 15,
    });

    if (decision.action === 'WAIT' || decision.action === 'SKIP') {
      report.skipped += 1;
      continue;
    }

    if (decision.action === 'MISS') {
      db.update(scheduleJobs)
        .set({
          status: 'MISSED',
          lockedAt: null,
          lastError: `window missed by ${decision.lateByMinutes} minutes`,
          updatedAt: now.getTime(),
        })
        .where(eq(scheduleJobs.id, row.id))
        .run();

      db.insert(systemEvents)
        .values({
          kind: 'schedule.missed',
          severity: 'WARN',
          payload: JSON.stringify({
            jobId: row.id,
            contentItemId: row.contentItemId,
            lateByMinutes: decision.lateByMinutes,
          }),
        })
        .run();

      // D2: the machine was asleep. This needs a decision, not a log line.
      createInAppNotifier(db).notifySync({
        kind: 'JOB_MISSED',
        title: 'A scheduled post missed its window',
        body:
          `It was due ${decision.lateByMinutes} minutes ago and was not ` +
          'published. Reschedule it, publish it anyway, or cancel it.',
        contentItemId: row.contentItemId,
        dedupeKey: `missed:${row.id}`,
        now,
      });

      report.missed += 1;
      continue;
    }

    if (!claimJob(db, row.id, now, lockStaleMs)) {
      report.skipped += 1;
      continue;
    }

    const outcome = await publishJob(db, row.id, publisherFor, now);
    if (outcome === 'PUBLISHED') report.published += 1;
    else if (outcome === 'AWAITING_HUMAN') report.awaitingHuman += 1;
    else report.failed += 1;
  }

  return report;
}

async function publishJob(
  db: DB,
  jobId: number,
  publisherFor: (platform: Platform) => Publisher,
  now: Date,
): Promise<'PUBLISHED' | 'AWAITING_HUMAN' | 'FAILED'> {
  const job = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.id, jobId))
    .get();

  if (!job) return 'FAILED';

  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, job.contentItemId))
    .get();

  if (!item) return 'FAILED';

  const attempts = job.attempts + 1;

  try {
    // SCHEDULED -> PUBLISHING. The domain refuses this from anywhere else.
    if (item.state === 'SCHEDULED') {
      moveTo(db, item.id, 'PUBLISHING', {
        actor: 'scheduler',
        note: `job ${jobId} attempt ${attempts}`,
        now,
      });
    }

    const request: PublishRequest = {
      contentItemId: item.id,
      platform: item.platform,
      format: item.format,
      caption: item.caption ?? '',
      mediaPaths: [],
      idempotencyKey: job.idempotencyKey,
    };

    const result = await publisherFor(item.platform).publish(request);

    if (result.outcome === 'AWAITING_HUMAN') {
      // The item stays in PUBLISHING. Nothing is recorded as published,
      // because nothing has been (§40).
      db.update(scheduleJobs)
        .set({
          status: 'AWAITING_HUMAN',
          attempts,
          lockedAt: null,
          lastError: null,
          updatedAt: now.getTime(),
        })
        .where(eq(scheduleJobs.id, jobId))
        .run();

      db.insert(systemEvents)
        .values({
          kind: 'publish.awaiting_human',
          severity: 'INFO',
          payload: JSON.stringify({
            jobId,
            contentItemId: item.id,
            instructions: result.instructions,
          }),
        })
        .run();

      return 'AWAITING_HUMAN';
    }

    if (result.outcome === 'PUBLISHED') {
      recordPublication(db, {
        contentItemId: item.id,
        jobId,
        platform: item.platform,
        publisherKind: publisherFor(item.platform).kind,
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        confirmedBy: result.confirmedBy,
        publishedAt: result.publishedAt,
        actor: 'scheduler',
        now,
      });

      db.update(scheduleJobs)
        .set({
          status: 'SUCCEEDED',
          attempts,
          lockedAt: null,
          updatedAt: now.getTime(),
        })
        .where(eq(scheduleJobs.id, jobId))
        .run();

      return 'PUBLISHED';
    }

    return failJob(db, jobId, item.id, attempts, result.error, result.retryable, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failJob(db, jobId, item.id, attempts, message, true, now);
  }
}

function failJob(
  db: DB,
  jobId: number,
  contentItemId: number,
  attempts: number,
  error: string,
  retryable: boolean,
  now: Date,
): 'FAILED' {
  const job = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.id, jobId))
    .get();

  const exhausted = !retryable || attempts >= (job?.maxAttempts ?? 3);

  db.update(scheduleJobs)
    .set({
      status: exhausted ? 'FAILED' : 'PENDING',
      attempts,
      lockedAt: null,
      lastError: error,
      // §40: back off rather than hammering a failing platform.
      runAt: exhausted
        ? (job?.runAt ?? now.getTime())
        : now.getTime() + retryDelayMs(attempts),
      updatedAt: now.getTime(),
    })
    .where(eq(scheduleJobs.id, jobId))
    .run();

  db.insert(systemEvents)
    .values({
      kind: 'publish.failed',
      severity: exhausted ? 'ERROR' : 'WARN',
      payload: JSON.stringify({ jobId, contentItemId, attempts, error }),
    })
    .run();

  if (exhausted) {
    createInAppNotifier(db).notifySync({
      kind: 'PUBLISH_FAILED',
      title: 'Publishing failed',
      body:
        `After ${attempts} attempt(s): ${error}. Nothing was marked as ` +
        'published, and the item is back for revision.',
      contentItemId,
      dedupeKey: `publish-failed:${jobId}`,
      now,
    });

    // §40: never left in PUBLISHING, never marked published. It goes to a
    // human.
    const state = db
      .select({ state: contentItems.state })
      .from(contentItems)
      .where(eq(contentItems.id, contentItemId))
      .get()?.state;

    if (state === 'PUBLISHING') {
      moveTo(db, contentItemId, 'NEEDS_REVISION', {
        actor: 'scheduler',
        note: `publishing failed after ${attempts} attempt(s): ${error}`,
        now,
      });
    }
  }

  return 'FAILED';
}

export interface RecordPublicationInput {
  readonly contentItemId: number;
  readonly jobId?: number | null;
  readonly platform: Platform;
  readonly publisherKind: 'MANUAL' | 'INSTAGRAM_API' | 'LINKEDIN_API';
  readonly externalId?: string | null;
  readonly externalUrl?: string | null;
  readonly confirmedBy?: string | null;
  readonly publishedAt: Date;
  readonly actor?: string;
  readonly now?: Date;
}

/**
 * Writes the publication record and moves the item to PUBLISHED.
 *
 * Both happen in one transaction, and the state move is validated first —
 * the domain guard refuses PUBLISHED without evidence, and the database
 * CHECK refuses a record with neither an external id nor a human
 * confirmation. Evidence exists before either write lands.
 */
export function recordPublication(db: DB, input: RecordPublicationInput): void {
  const now = input.now ?? new Date();

  if (!input.externalId && !input.confirmedBy) {
    throw new ScheduleError(
      'A publication record needs an external ID or a human confirmation (§40).',
    );
  }

  db.insert(publicationRecords)
    .values({
      contentItemId: input.contentItemId,
      jobId: input.jobId ?? null,
      platform: input.platform,
      publisherKind: input.publisherKind,
      externalId: input.externalId ?? null,
      externalUrl: input.externalUrl ?? null,
      confirmedBy: input.confirmedBy ?? null,
      publishedAt: input.publishedAt.getTime(),
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    })
    .run();

  moveTo(db, input.contentItemId, 'PUBLISHED', {
    actor: input.actor ?? 'system',
    note: input.externalUrl ?? 'published',
    patch: { publishedAt: input.publishedAt.getTime() },
    now,
  });
}

/**
 * Confirms that a human actually posted something — decision D1.
 *
 * This is the only path from PUBLISHING to PUBLISHED while the manual
 * publisher is in use, and it requires a person's name. The system cannot
 * confirm on their behalf.
 */
export function confirmManualPublish(
  db: DB,
  input: {
    contentItemId: number;
    externalUrl?: string;
    confirmedBy: string;
    publishedAt?: Date;
    now?: Date;
  },
): void {
  const now = input.now ?? new Date();

  if (!input.confirmedBy.trim()) {
    throw new ScheduleError('Confirmation needs the name of who posted it.');
  }

  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get();

  if (!item) throw new ScheduleError(`No content item ${input.contentItemId}`);

  const job = db
    .select()
    .from(scheduleJobs)
    .where(
      and(
        eq(scheduleJobs.contentItemId, input.contentItemId),
        eq(scheduleJobs.status, 'AWAITING_HUMAN'),
      ),
    )
    .orderBy(desc(scheduleJobs.id))
    .get();

  recordPublication(db, {
    contentItemId: input.contentItemId,
    jobId: job?.id ?? null,
    platform: item.platform,
    publisherKind: 'MANUAL',
    ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
    confirmedBy: input.confirmedBy,
    publishedAt: input.publishedAt ?? now,
    actor: input.confirmedBy,
    now,
  });

  if (job) {
    db.update(scheduleJobs)
      .set({ status: 'SUCCEEDED', lockedAt: null, updatedAt: now.getTime() })
      .where(eq(scheduleJobs.id, job.id))
      .run();
  }
}

/** Decides what to do with a job whose window was missed — decision D2. */
export function resolveMissedJob(
  db: DB,
  jobId: number,
  resolution: 'PUBLISH_NOW' | 'RESCHEDULE' | 'CANCEL',
  opts: { runAt?: Date; actor?: string; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();

  const job = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.id, jobId))
    .get();

  if (!job || job.status !== 'MISSED') {
    throw new ScheduleError(`Job ${jobId} is not awaiting a missed-window decision.`);
  }

  if (resolution === 'CANCEL') {
    db.update(scheduleJobs)
      .set({ status: 'CANCELLED', updatedAt: now.getTime() })
      .where(eq(scheduleJobs.id, jobId))
      .run();
    moveTo(db, job.contentItemId, 'APPROVED', {
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      note: 'missed window — cancelled',
      patch: { scheduledAt: null },
      now,
    });
    return;
  }

  const runAt = resolution === 'PUBLISH_NOW' ? now : opts.runAt;
  if (!runAt) {
    throw new ScheduleError('Rescheduling needs a new time.');
  }

  db.update(scheduleJobs)
    .set({
      status: 'PENDING',
      runAt: runAt.getTime(),
      lastError: null,
      lockedAt: null,
      // Publishing now means accepting the delay deliberately, so the grace
      // window must not immediately mark it missed again.
      graceWindowMinutes:
        resolution === 'PUBLISH_NOW' ? 1440 : job.graceWindowMinutes,
      updatedAt: now.getTime(),
    })
    .where(eq(scheduleJobs.id, jobId))
    .run();

  db.update(contentItems)
    .set({ scheduledAt: runAt.getTime(), updatedAt: now.getTime() })
    .where(eq(contentItems.id, job.contentItemId))
    .run();
}

/** Jobs needing a human decision or action. */
export function jobsNeedingAttention(db: DB) {
  return db
    .select({
      id: scheduleJobs.id,
      contentItemId: scheduleJobs.contentItemId,
      runAt: scheduleJobs.runAt,
      status: scheduleJobs.status,
      lastError: scheduleJobs.lastError,
      platform: contentItems.platform,
      format: contentItems.format,
      caption: contentItems.caption,
      state: contentItems.state,
    })
    .from(scheduleJobs)
    .innerJoin(contentItems, eq(contentItems.id, scheduleJobs.contentItemId))
    .where(inArray(scheduleJobs.status, ['MISSED', 'AWAITING_HUMAN', 'FAILED']))
    .orderBy(asc(scheduleJobs.runAt))
    .all();
}

/** The upcoming queue. */
export function upcomingJobs(db: DB) {
  return db
    .select({
      id: scheduleJobs.id,
      contentItemId: scheduleJobs.contentItemId,
      runAt: scheduleJobs.runAt,
      timezone: scheduleJobs.timezone,
      status: scheduleJobs.status,
      platform: contentItems.platform,
      format: contentItems.format,
      state: contentItems.state,
    })
    .from(scheduleJobs)
    .innerJoin(contentItems, eq(contentItems.id, scheduleJobs.contentItemId))
    .where(eq(scheduleJobs.status, 'PENDING'))
    .orderBy(asc(scheduleJobs.runAt))
    .all();
}

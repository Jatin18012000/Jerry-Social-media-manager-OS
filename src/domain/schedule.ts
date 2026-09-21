/**
 * Scheduling rules — PRD §24, §39, §40, and decision D2.
 *
 * Pure decision logic. The application layer does the claiming and writing;
 * everything about *whether* a job should run lives here so it can be tested
 * without a clock or a database.
 *
 * The rule that matters most comes from D2. The system runs on a MacBook,
 * which sleeps. A job scheduled for 09:00 may first be seen at 16:00, and
 * firing it then is usually worse than not firing it at all — a post timed for
 * a morning audience landing in the evening is a worse outcome than a post
 * that visibly did not go out. So an overdue job past its grace window is
 * MISSED and surfaced for a human decision, never fired silently.
 */

export type JobDecision =
  | { readonly action: 'RUN' }
  | { readonly action: 'WAIT'; readonly msUntilDue: number }
  | { readonly action: 'MISS'; readonly lateByMinutes: number }
  | { readonly action: 'SKIP'; readonly reason: string };

export interface SchedulableJob {
  readonly id: number;
  readonly runAt: number;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly graceWindowMinutes: number;
  readonly lockedAt: number | null;
}

/** A lock older than this is assumed to belong to a crashed run. */
export const LOCK_STALE_MINUTES = 15;

/**
 * Decides what to do with one job at a given moment.
 *
 * Ordering matters: terminal statuses are checked before lateness, so a
 * cancelled job is never resurrected by being overdue.
 */
export function decideJob(
  job: SchedulableJob,
  now: Date,
  opts: { lockStaleMinutes?: number } = {},
): JobDecision {
  const nowMs = now.getTime();
  const lockStaleMs = (opts.lockStaleMinutes ?? LOCK_STALE_MINUTES) * 60_000;

  if (job.status === 'SUCCEEDED') {
    return { action: 'SKIP', reason: 'already succeeded' };
  }
  if (job.status === 'CANCELLED') {
    return { action: 'SKIP', reason: 'cancelled' };
  }
  if (job.status === 'MISSED') {
    return { action: 'SKIP', reason: 'awaiting a decision on a missed window' };
  }
  if (job.status === 'AWAITING_HUMAN') {
    return { action: 'SKIP', reason: 'awaiting manual publish confirmation' };
  }
  if (job.attempts >= job.maxAttempts) {
    return { action: 'SKIP', reason: 'attempts exhausted' };
  }

  // A live lock means another runner has it. A stale one means that runner
  // died — SQLite gives us no process liveness, so time is the only signal.
  if (job.lockedAt !== null && nowMs - job.lockedAt < lockStaleMs) {
    return { action: 'SKIP', reason: 'locked by another runner' };
  }

  if (nowMs < job.runAt) {
    return { action: 'WAIT', msUntilDue: job.runAt - nowMs };
  }

  const lateByMs = nowMs - job.runAt;
  const graceMs = job.graceWindowMinutes * 60_000;

  if (lateByMs > graceMs) {
    return {
      action: 'MISS',
      lateByMinutes: Math.round(lateByMs / 60_000),
    };
  }

  return { action: 'RUN' };
}

/**
 * The idempotency key for a publication attempt — §39.
 *
 * Readable rather than hashed, deliberately: when a duplicate-key error shows
 * up in a log at 2am, `12:INSTAGRAM:1758441600000` tells you which item and
 * which slot collided, and an opaque digest does not.
 *
 * Rescheduling to a different time produces a different key, which is correct:
 * that is a genuinely different publication attempt.
 */
export function idempotencyKey(
  contentItemId: number,
  platform: string,
  runAt: Date | number,
): string {
  const ms = runAt instanceof Date ? runAt.getTime() : runAt;
  return `${contentItemId}:${platform}:${ms}`;
}

/** Exponential backoff for a retryable failure — §40. */
export function retryDelayMs(attempt: number, baseMs = 60_000): number {
  const capped = Math.min(attempt, 6);
  return baseMs * 2 ** Math.max(0, capped - 1);
}

/**
 * Whether a scheduled time is far enough ahead to be worth scheduling.
 *
 * Scheduling something for one minute from now is almost always a mistake —
 * it means the operator meant "publish now", and the scheduler would race the
 * poll interval.
 */
export const MIN_LEAD_MINUTES = 2;

export function validateScheduleTime(
  runAt: Date,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  const leadMs = runAt.getTime() - now.getTime();

  if (Number.isNaN(runAt.getTime())) {
    return { ok: false, reason: 'That is not a valid date and time.' };
  }
  if (leadMs < 0) {
    return { ok: false, reason: 'That time is in the past.' };
  }
  if (leadMs < MIN_LEAD_MINUTES * 60_000) {
    return {
      ok: false,
      reason: `Schedule at least ${MIN_LEAD_MINUTES} minutes ahead.`,
    };
  }
  return { ok: true };
}

import { describe, expect, it } from 'vitest';

import {
  LOCK_STALE_MINUTES,
  MIN_LEAD_MINUTES,
  type SchedulableJob,
  decideJob,
  idempotencyKey,
  retryDelayMs,
  validateScheduleTime,
} from './schedule';

const NOW = new Date('2026-09-21T12:00:00Z');

function job(overrides: Partial<SchedulableJob> = {}): SchedulableJob {
  return {
    id: 1,
    runAt: NOW.getTime(),
    status: 'PENDING',
    attempts: 0,
    maxAttempts: 3,
    graceWindowMinutes: 30,
    lockedAt: null,
    ...overrides,
  };
}

describe('decideJob — timing', () => {
  it('waits for a job that is not due', () => {
    const decision = decideJob(job({ runAt: NOW.getTime() + 60_000 }), NOW);
    expect(decision.action).toBe('WAIT');
  });

  it('runs a job that is exactly due', () => {
    expect(decideJob(job(), NOW).action).toBe('RUN');
  });

  it('runs a job late but inside its grace window', () => {
    const late = new Date(NOW.getTime() + 20 * 60_000);
    expect(decideJob(job(), late).action).toBe('RUN');
  });
});

describe('decideJob — the MacBook-sleep rule (decision D2)', () => {
  it('marks a job MISSED once past its grace window', () => {
    // The Mac was asleep. Firing a 9am post at 4pm is worse than not firing.
    const muchLater = new Date(NOW.getTime() + 7 * 3_600_000);
    const decision = decideJob(job(), muchLater);
    expect(decision.action).toBe('MISS');
    if (decision.action === 'MISS') {
      expect(decision.lateByMinutes).toBe(420);
    }
  });

  it('never silently fires a job whose window has long passed', () => {
    const muchLater = new Date(NOW.getTime() + 24 * 3_600_000);
    expect(decideJob(job(), muchLater).action).not.toBe('RUN');
  });

  it('respects a longer grace window when one is configured', () => {
    const later = new Date(NOW.getTime() + 7 * 3_600_000);
    expect(decideJob(job({ graceWindowMinutes: 1440 }), later).action).toBe(
      'RUN',
    );
  });

  it('does not resurrect a cancelled job just because it is overdue', () => {
    const later = new Date(NOW.getTime() + 24 * 3_600_000);
    const decision = decideJob(job({ status: 'CANCELLED' }), later);
    expect(decision.action).toBe('SKIP');
  });

  it('leaves an already-missed job for a human', () => {
    const decision = decideJob(job({ status: 'MISSED' }), NOW);
    expect(decision.action).toBe('SKIP');
  });
});

describe('decideJob — terminal and in-flight states', () => {
  it('skips a succeeded job', () => {
    expect(decideJob(job({ status: 'SUCCEEDED' }), NOW).action).toBe('SKIP');
  });

  it('skips a job awaiting manual confirmation', () => {
    // §40: the human has it. Re-running would risk a second post.
    expect(decideJob(job({ status: 'AWAITING_HUMAN' }), NOW).action).toBe(
      'SKIP',
    );
  });

  it('skips a job whose attempts are exhausted', () => {
    expect(
      decideJob(job({ attempts: 3, maxAttempts: 3 }), NOW).action,
    ).toBe('SKIP');
  });
});

describe('decideJob — locking', () => {
  it('skips a job locked by a live runner', () => {
    const decision = decideJob(
      job({ lockedAt: NOW.getTime() - 60_000, status: 'RUNNING' }),
      NOW,
    );
    expect(decision.action).toBe('SKIP');
  });

  it('reclaims a job whose lock has gone stale', () => {
    // No process liveness in SQLite; time is the only signal a runner died.
    const staleLock = NOW.getTime() - (LOCK_STALE_MINUTES + 5) * 60_000;
    const decision = decideJob(
      job({ lockedAt: staleLock, status: 'RUNNING' }),
      NOW,
    );
    expect(decision.action).toBe('RUN');
  });
});

describe('idempotencyKey — PRD §39', () => {
  it('is stable for the same item, platform and slot', () => {
    const a = idempotencyKey(12, 'INSTAGRAM', NOW);
    const b = idempotencyKey(12, 'INSTAGRAM', NOW.getTime());
    expect(a).toBe(b);
  });

  it('differs across platforms', () => {
    expect(idempotencyKey(12, 'INSTAGRAM', NOW)).not.toBe(
      idempotencyKey(12, 'LINKEDIN', NOW),
    );
  });

  it('differs across items', () => {
    expect(idempotencyKey(12, 'INSTAGRAM', NOW)).not.toBe(
      idempotencyKey(13, 'INSTAGRAM', NOW),
    );
  });

  it('differs when rescheduled — a genuinely different attempt', () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(idempotencyKey(12, 'INSTAGRAM', NOW)).not.toBe(
      idempotencyKey(12, 'INSTAGRAM', later),
    );
  });

  it('is readable, so a collision in a log can be diagnosed', () => {
    expect(idempotencyKey(12, 'INSTAGRAM', NOW)).toBe(
      `12:INSTAGRAM:${NOW.getTime()}`,
    );
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
  });

  it('caps so a long-failing job does not retry in a decade', () => {
    expect(retryDelayMs(50)).toBe(retryDelayMs(6));
  });
});

describe('validateScheduleTime', () => {
  it('accepts a time comfortably ahead', () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(validateScheduleTime(future, NOW).ok).toBe(true);
  });

  it('rejects a time in the past', () => {
    const past = new Date(NOW.getTime() - 60_000);
    const result = validateScheduleTime(past, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('in the past');
  });

  it('rejects a time too close to now', () => {
    // Almost always means "publish now", and it races the poll interval.
    const soon = new Date(NOW.getTime() + 30_000);
    const result = validateScheduleTime(soon, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(String(MIN_LEAD_MINUTES));
    }
  });

  it('rejects an invalid date', () => {
    expect(validateScheduleTime(new Date('nonsense'), NOW).ok).toBe(false);
  });
});

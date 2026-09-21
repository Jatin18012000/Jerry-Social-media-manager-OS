# 8. Scheduling on a machine that sleeps, and never publishing twice

Status: Accepted — 2026-09-21

## Context

M3 adds the approval gate, the scheduler and publishing. Two failures here are
visible to an audience and cannot be undone: publishing the same thing twice,
and recording something as published that never was. §39 and §40 name both.

Decision D2 adds a third problem the PRD does not anticipate. The system runs
on a MacBook, which sleeps. A job scheduled for 09:00 may first be seen at
16:00.

## Decision

**Four independent layers stop a double publish.**

1. `UNIQUE(idempotency_key)` on `schedule_jobs` — one job per item, platform
   and slot. Re-submitting the same schedule returns the existing job rather
   than erroring, because a double-clicked form is not an error.
2. An atomic conditional `UPDATE` claims a job. Two runners cannot both take
   it, because SQLite serialises the write; a check-then-update would leave a
   window where both see it free.
3. `UNIQUE(content_item_id, platform)` on `publication_records` — the database
   refuses a second publication whatever the application believes.
4. The state machine will not enter `PUBLISHED` without publication evidence.

A test runs two `runDueJobs` calls concurrently against one due job and asserts
exactly one publication.

The idempotency key is readable (`12:INSTAGRAM:1758441600000`) rather than
hashed. When a duplicate-key error appears in a log, the key should say which
item and which slot collided.

**A missed window is a decision, not a default.**

A job overdue by more than its grace window (30 minutes by default) is marked
`MISSED` and surfaced with three choices: reschedule, publish now anyway, or
cancel. It is never fired silently.

This is the right default because a post timed for a morning audience landing
at 4pm is a worse outcome than a post that visibly did not go out — and the
second is recoverable while the first is not. "Publish now anyway" stays
available because sometimes the timing did not matter.

**The manual publisher never reports PUBLISHED.**

It returns `AWAITING_HUMAN` with instructions and leaves the item in
`PUBLISHING`. It has no way to know whether anything was posted, so under §40
it may not say. Confirmation requires a person's name, and the system cannot
supply one on their behalf.

**A failed publish goes to a human, never to PUBLISHED.** Retries back off
exponentially; when attempts are exhausted the item moves to `NEEDS_REVISION`
with the error recorded. A publisher that throws mid-request is treated the
same way — a test asserts no publication record survives it.

**The QA gate blocks only on what is objectively wrong.**

Missing caption, caption over the platform limit, too many hashtags,
unverified claims. Everything subjective — a weak hook, a placeholder brand, a
missing CTA — is a warning that travels with the item to review. §22 makes
human approval the one mandatory gate in V1; a gate that cries wolf gets
clicked through, and then the mandatory gate is worth nothing.

**The runner lives in the Next.js process**, started from
`instrumentation.ts`, polling every 30 seconds. §54 warns against unnecessary
services and a single-user system on one laptop does not need a separate
worker. It is guarded against double registration, because Next.js re-executes
modules on hot reload and stacked intervals would mean several runners per
job.

## Consequences

Four layers of double-publish protection is more than the happy path needs,
and some of it will never fire. That is the correct ratio for an
unrecoverable, publicly visible failure.

Missed windows will be common — this is a laptop. The schedule screen is built
around that rather than treating it as an error state, so the routine case
looks routine.

When Instagram and LinkedIn publishers arrive in M6, they slot into the same
registry and every guarantee above already covers them. The only new work is
the API call itself.

# 4. Enforce the non-recoverable PRD rules in depth

Status: Accepted — 2026-09-21

## Context

Most bugs in this system are recoverable: a bad caption is edited, a missed
schedule is rescheduled. Two failures are not.

- Publishing content the human never approved (§22 requires mandatory
  approval, §54 excludes autonomous publishing from V1).
- Marking content as published when it was not, or publishing it twice
  (§39 idempotency, §40 "platform API fails → do not mark as published").

Both are visible to an audience and cannot be undone.

## Decision

Enforce these rules at more than one level, and never only in the UI.

| Rule | Domain | Database |
|---|---|---|
| §22 approval gate | `SCHEDULED` is reachable only from `APPROVED`, in the transition table | — |
| §40 publish evidence | guard on the transition into `PUBLISHED` | `CHECK` requiring an external ID or a human confirmation |
| §39 no double publish | idempotency key on the job | `UNIQUE(content_item_id, platform)` |
| §7.2 verified claims | `mayBeStatedAsFact()` | `CHECK` requiring evidence URL and tier when status is VERIFIED |

The state machine lives in `src/domain/content-state.ts` and is the single
authority on what may happen to a content item. It returns the event to
persist rather than writing anything itself, so state and audit event are
written in one transaction — which is what makes "no silent state changes"
achievable rather than aspirational.

## Consequences

Some rules are expressed twice, and a future change must be made in both
places or tests will fail. That duplication is deliberate: the domain guard
can be bypassed by a bug in the application layer, and the database constraint
cannot.

340 exhaustive transition tests cover every ordered pair of states, so a
future edit to the transition table cannot quietly open a path that nothing
tests.

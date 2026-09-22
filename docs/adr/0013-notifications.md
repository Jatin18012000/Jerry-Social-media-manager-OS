# 13. Notifications: an inbox that stays worth reading

Status: Accepted — 2026-09-22

## Context

§47 lists the notifications the system should send. The `Notifier` port was
defined in M0 and had no implementation — a defined interface with no
implementor is dead code that looks like a feature.

§45's dashboard already shows counts of what needs attention, but only while
you are looking at it. §47's point is that you should not have to go looking.

## Decision

**A `notifications` table, distinct from `system_events`.** The two answer
different questions. `system_events` logs everything that happened, for
observability (§43). A notification is *addressed to a person* and carries
read state. Collapsing them would mean either a log full of things nobody
needs to see, or an inbox full of things nobody needs to act on.

**Repeats of the same unresolved thing collapse.** A notification may carry a
`dedupeKey`; a second notification with the same key refreshes the first
rather than adding to the pile. A source failing for a week produces one
unread item, not a hundred and sixty-eight.

This is the decision the whole feature rests on. An inbox that fills with
duplicates becomes something to ignore, and an ignored inbox is worse than no
inbox — it hides the one thing that mattered.

**A dismissed problem that recurs comes back unread.** Dismissing is not
silencing: if a source is still down after you dismissed it, the next failure
raises it again. Otherwise the first dismissal would suppress the problem
permanently.

**Only things a person must act on.** Content ready for review, a missed
window, an exhausted publish failure, a source that has stopped responding. A
*retryable* publish failure sends nothing, because the system is about to
retry it — interrupting someone for a transient failure it will handle itself
is how an inbox becomes noise. A test asserts that silence.

**Severity comes from the kind, not the caller.** A `PUBLISH_FAILED` is always
an error and a `SCHEDULED` is always informational. Letting each call site
choose would let severity drift until it stopped meaning anything.

**Dismissed is not deleted.** What happened stays visible as history.

**No email.** §48 is explicit that email is a channel and never the
orchestration mechanism, so the row *is* the notification. Adding email means
adding a second `Notifier` behind the same port — and it needs credentials
that do not exist yet.

## Consequences

The nav carries an unread badge, which makes the root layout read the database
per request. That is the price of §47's premise; the read is a single indexed
count, and it degrades to no badge rather than a broken page if the database
is unreachable — which it is on the login screen.

`dedupeKey` keys are constructed by callers (`source-failing:7`,
`missed:12`). They are effectively a small shared vocabulary, and two call
sites choosing the same key by accident would merge unrelated notifications.
The keys are namespaced by purpose to make that unlikely, and each is written
next to the only code that produces it.

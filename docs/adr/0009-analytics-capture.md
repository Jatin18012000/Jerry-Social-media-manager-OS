# 9. Analytics capture: read, then confirm

Status: Accepted — 2026-09-21

## Context

Decision D4 chose screenshot → local OCR → confirm → database for getting
metrics in before platform API access clears.

§67 says the product is a machine that learns how to produce better content.
Analytics is that machine's only input. Corrupting it is therefore the worst
available failure in the system — worse than a bad caption, worse than a
missed schedule — because every conclusion downstream inherits the error and
nothing surfaces it.

§40 already says not to fabricate metrics. The risk with OCR is subtler than
outright fabrication: a parser that is confidently wrong produces data that
looks real.

## Decision

**Absent is not zero. Everywhere.**

Every metric column is nullable, every field in the parser's output is
optional, and the UI renders an em-dash rather than a 0. "The platform did not
report this" and "the platform reported zero" are different facts. A zero
where data is missing reads as a real result — a post that reached nobody —
and would drag every aggregate toward a conclusion nobody's content earned.

**The parser is conservative by construction.**

It claims a metric only when a recognised label sits beside a readable number.
It never infers from position alone, never assigns one number to two metrics,
and drops any metric the platform does not actually report — reading "saves"
off LinkedIn would be inventing a platform capability, which §7.1 forbids.

Pairing is decided by layout, not distance: a number sharing a line with its
label wins outright, and across lines the number *above* wins, because
Insights panels stack value over label and indentation makes the distances
identical. Getting this wrong is not theoretical — an earlier version read
`Saves 45\nLikes 10` as 45 likes.

**Reading and writing are separate steps.** `previewReading` writes nothing.
The human sees the parsed numbers in an editable form and saves them. An OCR
reading with no confirmer is rejected outright. That confirm step is the whole
reason OCR is acceptable under §40.

**The raw OCR text is retained**, so a better parser can re-read old
screenshots rather than asking for them again.

**Snapshots are append-only.** Metrics move for days after publishing and §29
needs the series. Reads use the latest snapshot per item rather than summing,
because snapshots are cumulative readings and summing them would double-count.

**Metrics for an unpublished item are refused.** They cannot be meaningful and
would corrupt every aggregate computed later.

**Pasted text is the primary path, not the fallback.** macOS Live Text reads a
screenshot in Preview with no setup and better accuracy on UI screenshots than
anything installable. Tesseract is offered for a fully automated image path;
both feed the same parser, so the guarantees hold either way.

## Consequences

Capture costs a paste and a glance per post rather than being automatic. That
is the price of D4's zero-cost constraint, and it disappears when the
Instagram Insights API arrives — `InstagramInsightsSource` slots in behind the
same port and every guarantee above still applies.

The parser will miss metrics on layouts it has not seen. It is built to fail
that way round: a missed metric is a gap the human fills, and a wrongly-read
one is a lie the learning engine believes.

The Tesseract path has not been exercised on macOS from this development
environment. Its command construction is simple, but the first real run should
be treated as a test.

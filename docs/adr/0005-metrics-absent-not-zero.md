# 5. An unreported metric is NULL, never zero

Status: Accepted — 2026-09-21

## Context

PRD §26 lists the metrics to capture and notes that availability depends on
the platform and its API. §40 states that when analytics are unavailable the
system must not fabricate metrics. §29 requires the learning engine to
distinguish observation from causal conclusion.

In V1, metrics arrive by screenshot and local OCR, which can fail to read a
field that is present on screen.

## Decision

Every metric column in `analytics_snapshots` is nullable, and every field in
the `MetricReading` port type is optional. "The platform did not report this"
and "the platform reported zero" are stored as different values.

Snapshots are append-only rather than mutable columns on the content item,
because metrics move for days after publishing and §29's analysis needs the
time series.

OCR readings below a confidence threshold are never written silently. They
produce a pre-filled form for human confirmation. `raw_ocr_text` is retained
so a parser improvement can be re-run over old screenshots.

## Consequences

Every consumer of metrics must handle null, which is slightly more work at
every call site.

The alternative — defaulting to zero — would silently poison the learning
engine, because a post with unread metrics would look like a post that
performed terribly. Given that §67 defines the entire product as a machine
that learns, corrupting its only input is the worst available failure.

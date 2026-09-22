# 20. Research pillars, the character rule, and analytics attribution

Status: Accepted — 2026-09-22 (Product decisions, P0)

Three locked product rules that share one property: each is a place where the
system could produce a confident number or sentence that nobody is entitled
to. They are recorded together because the failure mode is the same.

---

## 1. Pillars apply to research, not only to content

The classifier already decided a pillar for every research item and
**ingestion discarded it** — `research_items` had no pillar column. Pillar
filtering, prioritisation, and detecting over- or under-production by pillar
all need it.

**Primary pillar** may be set by the classifier at ingestion and corrected by
a human. **Secondary pillars are human-assigned only** — no model, no
heuristic, no multi-label classification. Early pillar analytics is worth
having only if it is trustworthy, and seeding it with machine guesses would
corrupt the measurement it exists to enable. Every secondary row records who
assigned it, and an unattributed assignment is refused.

Automated secondary classification is a later decision that needs real data
first, not an omission.

**`NULL` means UNCLASSIFIED, and that is an outcome.** An item fitting none of
the four approved pillars is not pushed into the nearest one — that would be
inventing a classification (§7.1) — and no fifth "Other" pillar is created,
which would be the same invention with a label. Pillar counts report
unclassified items separately and never fold them into a pillar, because an
unclassified item counted anywhere overstates that pillar's share. This is
§29's habit of distinguishing "we do not know" from a value, applied to
classification.

**No backfill.** Existing rows stay `NULL`. They were ingested before the
classifier's answer was retained, and back-dating a classification now would
invent history.

**Additive migration.** A nullable column, a join table, an index. Nothing
dropped, no table rebuilt, every existing row still valid — asserted by a test
that applies the migration to a database already holding research and claims
and checks the data afterwards.

A join table rather than `secondary_1 / secondary_2` columns, because an event
can legitimately span more than two pillars and a fixed pair would be the
wrong model on the first one that does.

---

## 2. The AI character may not fabricate Jatin's experience

The AI character is a visual and creative representation of Jatin and the
brand. It is **not an autonomous replacement for him.**

It must never fabricate his real-world experiences, actions, employment,
relationships, conversations, opinions, achievements, first-person testing or
usage, or personal anecdotes that did not occur.

```
INVALID   "I tested this AI tool last week."       (unless he did)
INVALID   "When I worked at X, I learned..."       (unless real and approved)
VALID     "Here's what the new model can do."
VALID     "Jatin's take: ..."                      (only when he supplied it)
```

`mayClaimRealExperience()` in the domain implements this and **must not be
weakened**. The rule is recorded here so the reason survives independently of
the function.

---

## 3. Follower growth is not attributed to a post

**Never attribute follower growth to an individual post unless the platform
explicitly reports it at post level.** Account-level follower changes remain
account-level facts.

Valid per-post metrics are those the platform reports per post: views, likes,
comments, shares, saves, and profile visits where available. Attribution is
never inferred from timing, and the learning engine may not treat an
account-level follower increase as evidence that a particular post produced
it.

`PLATFORM_METRICS` is the attribution boundary, and it is now enforced on
**both** entry paths. The OCR parser already filtered by it; manual entry did
not, so a number could be typed against a post on a platform that never
reports it. `saveReading` now refuses that, naming the platform and the
metric.

**Which platforms report post-level follows is an unverified vendor fact.**
The list is the lever and it is not changed without primary-source evidence
(§7.1, §7.2). This is a live item on the validation checklist, not a settled
question.

This composes with §29 rather than replacing it: even where a platform does
report post-level follows, a correlation between a segment and higher follows
is an observation, and reaches `SUPPORTED` only through a completed
pre-registered experiment.

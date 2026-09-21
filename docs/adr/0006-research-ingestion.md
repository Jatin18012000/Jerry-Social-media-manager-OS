# 6. Research ingestion: propose, never conclude

Status: Accepted — 2026-09-21

## Context

M1 builds the research engine (§14, §15, §16). Two decisions in it could
quietly violate §7, the cross-agent truth policy, if made carelessly.

**Deduplication.** The same story arrives from a company blog, a paper and
three publications. Collapsing them is valuable; collapsing them wrongly is
invisible, because a discarded item leaves no trace to notice.

**Claim extraction.** §16 wants claims with provenance. Under decision D3
there is no model available to read an article and decide what it asserts.

## Decision

**Dedupe is two separate mechanisms with different confidence.**

A matching canonical URL is decisive — same URL, same item, skip it. A
matching title is a *soft* signal: the item is stored anyway, with status
`DUPLICATE` and `duplicate_of_id` pointing at the original. Nothing is ever
deleted. A title match is additionally only accepted inside a 72-hour window,
because AI topics recur and "OpenAI announces a new model" in January and June
are two stories.

Token matching stems inflections ("releases"/"released"/"release") but never
touches tokens containing digits, so "GPT-5" and "GPT-4" cannot merge.

**Claim extraction proposes candidates and nothing more.**

A heuristic splits text into sentences and proposes a §7.3 type from marker
words, returning the signals that fired so a reviewer can see the reasoning.
Every claim it writes is `UNVERIFIED`. When signals conflict the weaker
category wins — a sentence that both asserts and predicts is a PREDICTION —
because over-claiming is the failure §7 exists to prevent.

The module has no verification capability and no field through which it could
express one. The database independently refuses a VERIFIED claim that cites no
evidence.

**Hacker News is a signal source, not an authority.** Its items are recorded
at credibility tier OTHER and store the target URL, not the discussion.
Authority comes from where a link points, never from the fact that it was
popular.

## Consequences

The research table accumulates rows that are known duplicates. That is the
intended cost: the queue filters them out, and a wrong merge stays
recoverable.

Heuristic claim candidates will be mediocre — roughly right on obvious release
announcements, weak on analysis. That is acceptable because they are proposals
for a human, and §7.4 prefers an admitted gap to a confident error. When a
local model is wired in, it replaces the proposer behind the same interface
and the guarantees do not change.

# 17. The research pillar is classified once, at ingest

Status: Accepted — 2026-09-22

## Context

`classifyResearchItem` (§15, §36) decides three things about a research item:
which pillar it belongs to, how relevant it is, and what language it is in.
Until now ingest persisted only the relevance score. The pillar was computed
and discarded, which had three costs:

- Research could not be filtered or grouped by pillar anywhere in the UI.
- The Obsidian export rendered `pillar: null` in every research note, because
  there was nothing to render and naming a plausible pillar would have been
  inventing one (§7.1).
- The `agent_runs` record of each classification was misleading. A run that
  "succeeded" changed nothing in the database, so the §43/§44 question — is
  the local model actually being used, and is it any better — could not be
  answered by looking at what it produced.

`research_items` now carries a nullable `pillar_id` and a nullable `language`,
written from the classification at insert time. That raises a question the
system did not previously have to answer: what happens when the same item
could be classified again — because Ollama came up after a heuristic run,
because a pillar's keyword list changed, or because a pillar was added?

## Decision

**Classification runs once, at ingest, and is never re-run automatically.**

The stored pillar is the answer that was reached when the item arrived,
attributed by the `agent_runs` row written in the same operation. There is no
background re-classifier, and nothing re-reads an item to revise its pillar.

Three reasons, in order of weight:

**A silently revised pillar destroys the comparison.** §43 exists so that the
local model and the heuristics can be compared on real items. If a heuristic
verdict is quietly overwritten the moment the model comes up, the record of
what each path decided is gone, and with it the only evidence for whether the
model is worth running at all. The two paths have to leave separate,
attributable answers behind or the question is unanswerable (§67).

**Re-running is not free of judgement.** A second classification is a second
opinion, not a correction. Nothing in the first run failed — the heuristic
path is the default path, not a degraded one — so preferring the later answer
would be a policy choice about which agent is right, and engineering does not
get to make that call (§5). It belongs to Jatin.

**Nothing downstream is blocked by a stale pillar.** The pillar is a filing
and filtering aid on research. The pillar that governs a *post* lives on the
content opportunity and the content item, is set when a human promotes the
research, and is unaffected by this. A research item filed under the wrong
pillar is an inconvenience in a queue, not a wrong fact in anything published.

### What this means in practice

- An item ingested while Ollama was down keeps its heuristic pillar, and
  `agent_runs` says so.
- An unmatched pillar stores `NULL` and stays `NULL`. `/research` shows it as
  *unclassified* and the Obsidian export writes `pillar: null`. Neither
  substitutes a default, a most-common pillar or a best guess (§7.1). "Not
  determined" and "determined to be X" are different facts, exactly as
  "not reported" and "reported as zero" are for metrics (§40).
- Adding or editing a pillar does not retroactively reclassify anything. The
  new pillar applies to items ingested after it exists.
- `language` follows the same rule. The heuristic path cannot distinguish
  Hinglish from English, so it stores `NULL` rather than assuming `EN`; only
  the model path writes a language today.

## Consequences

The accepted cost is drift: as pillars are edited, older items keep pillars
assigned under older definitions, and a corpus-wide count by pillar mixes
vintages. That is tolerable for a filing aid and would not be for anything
publishing rests on.

If re-classification is wanted later, the shape this decision points at is an
explicit, human-triggered re-classification of a named set of items that
writes a new `agent_runs` row and leaves the prior verdict recoverable —
never an automatic background pass. That is a new decision, to be recorded
here when it is made, not an extension of this one.

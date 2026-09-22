# 15. Model-proposed claims, and the groundedness check

Status: Accepted — 2026-09-22

## Context

Claim extraction was heuristic: split sentences, type them by marker words.
It works on obvious release announcements and is poor at analysis. A local
model reads the text properly and tells an inference from a fact far better.

But claim extraction is the one place in this system where a model's
hallucination is genuinely dangerous, and it is worth being precise about why.

A hallucinated *pillar* falls back harmlessly. A hallucinated *metric* is
caught by the confirm step. A hallucinated **claim** is different: it is
stored against a research item, inherits that source's name and its §7.2
evidence tier, and is then handed to a writer inside a brief under the heading
"Verified facts — these may be stated as fact" once a human ticks it off. An
invented claim arrives wearing a primary source's authority.

That is §57's Risk 2 — research errors, severity HIGH — in its purest form.
And the failure is silent: a model that writes "trained on 15 trillion tokens"
where the source said 1.5 produces something that reads perfectly.

## Decision

**Every model-proposed claim is checked against the source text, and dropped
if it is not there.** This is what makes the model path acceptable at all.

The check has three layers, each closing a specific hole:

1. **Verbatim containment.** The normalised claim appearing in the normalised
   source passes outright. Normalisation handles the smart quotes, dashes and
   reflowed whitespace models substitute — not meaning.

2. **Every number must exist in the source.** A number-bearing token absent
   from the source anywhere is decisive rejection, with no threshold to hide
   behind. An altered number is the most dangerous output possible here
   because it is the most plausible.

3. **A reworded claim must match a *single* source sentence.** Not the text as
   a whole.

That third rule was added after the first implementation accepted something it
should not have. Two verbatim sentences welded together — "OpenAI released a
model **and will** expand availability next year" — contains only words from
the source and scores 100% token overlap against the whole text. It is still a
claim the source never made. Worse, it welds a FACT to a PREDICTION, and
typing the result FACT is precisely the flattening §7.3 exists to prevent. A
test now asserts that case is rejected, and that each half on its own is
accepted.

**An ungrounded claim is dropped individually**, not by rejecting the batch —
one bad claim should not cost the good ones. But if *nothing* survives, the
result falls back to heuristics rather than returning an empty list, because
an empty list reads as "this text makes no claims", which is a different and
false statement.

**Drops are recorded, not silent.** The `agent_runs` row carries status
`UNGROUNDED` and the reason. A model that is quietly fabricating shows up in
the System page as a pattern rather than as slightly odd claims nobody traced.

**The note on each stored claim says which path proposed it** and how it
matched — verbatim or near. A reviewer can see where a claim came from instead
of having to trust it.

**Nothing here verifies anything.** Every claim is written `UNVERIFIED`, and
the database independently refuses a `VERIFIED` claim with no evidence.

## Consequences

The check will reject some legitimate paraphrases, and the model's output will
sometimes be discarded wholesale. That asymmetry is deliberate: a dropped
claim costs a reviewer nothing, since the heuristics still propose from the
same text, and a false claim attributed to a primary source is the failure
this whole module exists to avoid.

Grounding is only as good as the source text stored. For a feed item that is
the summary, which may be a truncated teaser — so a model quoting accurately
from the full article would be rejected for quoting something we do not hold.
That is the right way round, but it does cap how much better the model path
can be until full article text is fetched.

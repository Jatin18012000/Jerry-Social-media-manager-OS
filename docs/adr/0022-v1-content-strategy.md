# 22. V1 content strategy and the Brand Constitution

Status: Accepted — 2026-09-23 (Product decisions, ChatGPT as Product owner)

## Context

Jatin asked engineering to add a content strategy for trending memes and
clickbait-style news with an AI angle, plus AI-generated adult content behind
a censor/uncensor toggle.

Engineering declined to decide any of it and escalated. §4 and §5 assign
content strategy to Jatin and ChatGPT; choosing what the account posts while
brand voice was still undefined would have amounted to inventing the brand.
ChatGPT ruled on all of it, and supplied the Brand Constitution that had been
the project's top blocker since the first status report.

This ADR records those rulings. It is not a place to extend them: engineering
must not derive further strategy from what is written here.

## A. Reach strategy — Option 2, topical with limits

Pursue timely AI trends, stronger hooks and shareable formats (Reels,
carousels). Rejected: substance-only (Option 1) as too slow, and
meme/clickbait-adjacent (Option 3) as irreconcilable with §7.

The boundary, in ChatGPT's words: **strong curiosity is allowed, false or
misleading curiosity is not.** No misleading clickbait, rage bait, fake
urgency, fabricated claims or material-context omission.

The operative rule, and the one most likely to bite in practice:

> No hook materially stronger than its evidence.

That is what separates the two kinds of curiosity, and it composes with §7.3
rather than softening it. A hook is still bound by the claim type underneath
it: an inference dressed as a fact is exactly the flattening the system was
built to prevent, and a strategy that rewards reach does not create an
exception to it.

**Not implemented.** This constrains what a human writes into a brief. The QA
gate could plausibly check it mechanically — it already knows each claim's
type and verification status — but "materially stronger" is a product
judgement, not an engineering one, and no one has defined it. Recorded as
available future work, deliberately not built.

## B. Trend sources — still frozen

P1 is not unfrozen. Live validation completes first; discovery and trend
sources may be considered afterwards.

The distinction that matters when they are:

> Trend sources supply topic, velocity, format and audience-interest signals.
> They do **not** establish factual claims.

Most meme and trend sources are not credible sources under §7.2 at any tier.
A future fetcher for them must feed the *selection* of what to cover, never
the evidence for what is asserted. Claims arriving through such a source stay
UNVERIFIED and continue to block STRATEGY_READY exactly as any other would.

## C. Adult content — excluded

Not implemented, and not to be implemented in this system: adult mode,
thirst-trap mode, a censor/uncensor toggle, or any sexualised-likeness
workflow.

Three reasons were weighed:

1. **Platform risk.** The OS publishes to Instagram and LinkedIn, both of
   which prohibit sexual content. A pipeline aimed at posting it there works
   against the account safety the whole system exists to protect (§57).
2. **A toggle would control nothing.** Generation is manual (decision D3):
   `ManualProvider` renders a brief a human pastes elsewhere. There is no
   model inside this OS whose output a switch could filter, so the control
   would look like a safety feature while providing none — which is worse
   than its absence.
3. **The AI character is Jatin's likeness** (ADR 0020). Sexualised content
   wearing it is a different product decision entirely.

If explored commercially later it is a separate product, with separate
accounts, brand and platforms. Nothing about it belongs behind a flag here.

Verified at the time of writing: no occurrence of adult, nsfw, thirst, censor
or uncensor anywhere in `src/`. Nothing was built, so nothing was removed.

## D. Brand Constitution v1

ChatGPT supplied a complete brand definition on 23 September 2026 — brand
name, positioning, both audiences, language policy, voice traits, do list,
avoid list and a reference line. It satisfies `productionBrandSchema`, which
requires every one of those fields to be non-empty.

**The content is deliberately not reproduced here.** §20 makes the database
the versioned home of the brand, and CLAUDE.md makes it the system of record.
A copy in an ADR would be a second source that goes stale the first time the
voice is edited, and "which one is the brand?" is not a question this project
should ever have to ask.

**Engineering did not enter it.** Per ADR 0019, a production brand can only be
activated by a named human with an explicit confirmation, and the activation
is audited. Jatin enters it at `/settings/brand`, saves a draft, reads it
back, and activates it under his own name. That sequence is the entire point
of the two-phase design, and the one time engineering wrote a brand
configuration here it was an accident worth not repeating.

One line from §3.6 was folded into the avoid list — *"any hook materially
stronger than its evidence"* — because it is the rule Option 2 most depends
on, and the avoid list is what actually reaches a brief.

### §3.6 prohibited claims

Recorded here in full because, unlike the brand voice, it currently has **no
home in the database**:

Fabricated facts, statistics, sources, quotes, events, capabilities, pricing,
benchmarks or personal experiences; unsupported performance claims;
guaranteed outcomes; unverified allegations; fabricated security claims;
unsupported motives; misleading omission; fake urgency; fabricated
first-person experience; sexualised Jatin likeness; and any hook materially
stronger than its evidence.

**Open question, previously raised as P0 §14.3 and still unanswered:** should
this become a stored, enforceable brand field rather than a document? As a
field it would reach every brief and could be versioned with the voice it
belongs to. As a document it changes only by deployment. Engineering has not
chosen, and will not.

## Consequences

- Brand voice stops being the top blocker the moment Jatin activates it.
  Until then every brief still carries its warning, correctly.
- §7.1, §7.2, §7.3 and §29 are untouched. Option 2 changes what is worth
  writing about, not what may be asserted.
- No code changed for any of A, B, C or D. This ADR is a record, not a
  feature.
- Live validation (V1–V5) remains outstanding and remains the gate on
  everything else.

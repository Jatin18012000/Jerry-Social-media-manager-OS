# 7. The brief loop: the system's contribution is the brief

Status: Accepted — 2026-09-21

## Context

Decision D3 put a human in the generation step: the system assembles a brief,
Jatin pastes it into Claude or Gemini, and pastes the reply back.

That changes what the product *is*. The system contributes no prose. Its
entire contribution to a piece of content is the quality of the brief it hands
over and the fidelity with which it takes the answer back. §66 already framed
it this way — the OS provides orchestration, memory, workflow and learning;
the models provide generation.

## Decision

**The brief carries everything, in one paste.** Brand voice, the opportunity's
thesis and angle, platform and format conventions, language guidance, and the
claims — each with its §7.3 type, its source, and its §7.2 evidence tier.

**Claims are grouped by what may be done with them**, not listed flat:

- *Verified facts* — may be stated as fact. Only a `FACT` that is `VERIFIED`
  qualifies; a verified PREDICTION is still a prediction.
- *Context* — examined but not fact. Must be framed as what it is.
- *Unverified* — explicitly barred from being stated as fact.

When nothing is verified the brief says so outright, rather than omitting the
section and letting silence imply permission.

**Facts come before style.** A writer skimming the brief hits what is true
before they hit how to sound.

**§51 is stated in the brief, not assumed.** In AI_CHARACTER or HYBRID mode
the brief either names the real experience Jatin supplied, or states that he
supplied none and the content must not imply any.

**A placeholder brand warns loudly.** Until a real voice is configured, every
brief opens with a banner saying so. §57 Risk 1 (generic AI content, severity
HIGH) is mitigated by a real voice or not at all, and a silent placeholder
would hide exactly that.

**Parsing never loses the paste.** The raw response is persisted *before*
parsing is attempted. Three strategies are tried — fenced JSON, bare JSON,
then markdown headings — and if all fail the whole text becomes the body with
a note about which fields need completing by hand. The server never rejects a
paste. Under D3 that text cost real human effort, and spending it twice
because of a parser bug is the worst thing this module could do.

## Consequences

The brief is long. That is the point: it is replacing the context a human
would otherwise re-explain to a chat window every time, and a shorter brief
would mean re-typing the brand voice daily.

Accepting sloppy model output means the parser has more paths than a strict
contract would need. That complexity buys a guarantee worth more than the
tidiness: no paste is ever refused.

When an API key is eventually authorised, `ManualProvider` is replaced by an
API provider behind the same port. The brief, the grouping rules, the §51
statement and the parser are all unchanged — only who reads the brief changes.

# 12. Local model classification, with heuristics as the default

Status: Accepted — 2026-09-22

## Context

The Claude Code Automation Guide adds Qwen via Ollama as a "local worker for
repetitive/simple AI operations", with a worked example (§8) of exactly the
job this system already does by keyword matching: duplicate, pillar,
relevance, language.

That confirms an assumption documented back at decision D3, where
"human-in-the-loop generation" was read as applying to *content*, not to
mechanical classification.

The guide also specifies the provider shape (§7): accept a task, model
configuration, input and output schema; return normalised structured output
plus metadata.

## Decision

**A `StructuredProvider` port, separate from `AIProvider`.** The two do
different jobs: `AIProvider` produces prose for a human to review;
`StructuredProvider` produces a typed judgement the application acts on. Under
D3 generation stays human and only this side is automated. Collapsing them
would blur that line.

**The heuristics are the default path, not the fallback.** This is the
important one. The laptop may not be running Ollama, the model may be
mid-download, a request may time out. When any of that happens the research
queue must keep working, so `classifyWithHeuristics` stays a first-class
implementation and `null` provider is a supported configuration.

**The model is never trusted to produce the right shape.** Its JSON is
extracted tolerantly — models wrap output in prose and code fences whatever
they are asked — and then validated strictly. An invented pillar slug, a
relevance outside 0..1, or a language the system does not model all return
`null` and fall through to the heuristics.

Returning `null` rather than a partially-valid object matters: a half-parsed
classification is worse than none, because it looks usable. §7.1 forbids
inventing capabilities, and a pillar the model made up is exactly that.

**Every attempt is recorded in `agent_runs`**, whichever path served it, with
status and duration (§43, §44). "Is the local model actually being used, and
is it any better than the keywords" then becomes a question the data answers
rather than a matter of belief. A model failing quietly shows up.

**The model tag is configuration with no default.** The guide cites a specific
tag; the development sandbox blocks the domain that would confirm it exists.
Whatever `ollama list` reports on the real machine is what goes in
`OLLAMA_MODEL`.

## Consequences

Classification quality now varies with whether the daemon is running, which
makes findings across that boundary less comparable. `agent_runs` records
which path served each item, so that is detectable rather than invisible.

The keyword lists stay maintained even once the model is in use. That is
duplication, and it is the price of the system working at all on a laptop.

**n8n was deferred in the same decision.** The OS owns scheduling and
publishing with four layers of double-publish protection; a second scheduler
would make §39 a property of whichever one ran. Revisit when there is a
concrete job the OS cannot do — most likely notifications (§47). If added, it
triggers and transports; it does not own state.

# 1. Record architecture decisions

Status: Accepted — 2026-09-21

## Context

PRD §60 rule 15 requires that major architectural decisions are recorded, and
§63 requires that major architectural changes create a documented version.

Product documentation for this project lives outside the repository. These
records are different: they are engineering decisions that only make sense
next to the code they constrain, and they should change in the same commit as
the code.

## Decision

Keep short architecture decision records in `docs/adr/`, numbered and
append-only. A record states the context, the decision, and its consequences —
including the ones we dislike.

Superseded records stay, marked as superseded, rather than being deleted. The
history of why something changed is the useful part.

## Consequences

Anyone (or any agent) picking up this codebase can find out why it is shaped
the way it is without reading the whole PRD or the conversation that produced
it. If these records are moved to the external documentation tool later, the
code loses that locality — so they stay here unless that trade is made
deliberately.

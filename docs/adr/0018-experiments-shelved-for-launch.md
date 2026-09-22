# 18. Experiments shelved for the initial launch phase

Status: Accepted — 2026-09-22 (Product decision, P0)

## Context

ADR 0017 built §30 pre-registered experiments as the only route to a
`SUPPORTED` finding. The framework is deliberately two-armed and requires a
minimum of five measured posts **per arm**, so the smallest possible
experiment costs ten posts.

At the locked initial cadence — up to two Instagram pieces a day, a target of
one LinkedIn post a day, and explicitly *targets rather than quotas* — a single
question would take weeks to answer, and the answer would arrive after the
window it was about had closed.

## Decision

**Experiments are shelved for the initial launch phase.** The first content
cycle runs:

```
OBSERVE → MEASURE → LEARN → HYPOTHESIZE
```

rather than requiring controlled tests. `EXPERIMENTS_MODE` defaults to
`SHELVED`; `ACTIVE` restores the feature.

Shelved, not deleted. The infrastructure stays compiled, tested and reachable:
the mode gates *behaviour*, not compilation, and nothing became dead code.

**Gated in the use case, not the UI.** `createExperiment` and
`startExperiment` refuse while shelved, so no route, script or server action
can get past it. The nav entry is hidden and `/experiments` explains that it
is parked rather than returning a 404 — a dead link reads like a bug, and this
is a decision.

**Reading and concluding are deliberately not gated.** An experiment already
running when the mode changed must stay readable and closable. Stranding real
data behind a configuration flag would be worse than never having run it.

## What shelving does not touch

This is the part worth being precise about, because it is the part that could
be quietly lost.

**§29's ceiling is unchanged.** Observational findings still stop at
`HYPOTHESIS`. `promoteWithExperiment` is still the only route to `SUPPORTED`.
With experiments shelved that route is simply not exercised.

Shelving removes the ability to *run* an experiment. It does not lower the bar
for concluding without one. A test pins this: eighty observations with a
forty-nine-fold difference between segments still yield no `SUPPORTED`
finding.

## Consequences

- No causal claims will be available during the launch phase. That is the
  intended trade: the alternative was causal claims resting on ten posts.
- The "Test this deliberately" link on a `HYPOTHESIS` finding is hidden while
  shelved, rather than leading to a page that refuses.
- Re-enabling is one environment variable and needs no migration or code
  change.

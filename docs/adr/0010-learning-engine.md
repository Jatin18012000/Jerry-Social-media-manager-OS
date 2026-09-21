# 10. The learning engine: observation is not causation

Status: Accepted — 2026-09-21

## Context

§67 is the PRD's closing rule and its most important one: *"Do not build a
machine that produces content. Build a machine that learns how to produce
better content."*

§29 says what that means in practice — the system must distinguish observation
from causal conclusion, and must not claim "Hinglish causes growth" from three
posts. §30 requires experiments with a hypothesis, a metric and a minimum
sample size fixed before the test runs.

The pressure here is obvious and constant. With a handful of posts and a
visible difference between them, everything in a dashboard's nature wants to
present that difference as a finding. This module exists to refuse.

## Decision

**Three tiers, and the top one is unreachable from observation.**

| Status | Reached by |
|---|---|
| `INSUFFICIENT_DATA` | below the minimum sample size, either side |
| `OBSERVATION` | enough data, but the difference could be noise |
| `HYPOTHESIS` | enough data, and a 95% interval excluding zero |
| `SUPPORTED` | **only** a concluded, pre-registered experiment |

Observational data stops at `HYPOTHESIS` however large the effect or the
sample. A test asserts this with 400 observations and an eight-fold
difference: still not `SUPPORTED`. You cannot get causation out of a queue of
things you happened to post, and the tier system is what stops the product
quietly pretending otherwise.

`promoteWithExperiment` is the only route to `SUPPORTED`, and it refuses an
experiment that has not concluded, that measured a different metric, or that
fell short of its pre-registered sample size. §30 fixes those *before* the run
precisely so a result cannot be reinterpreted afterwards.

**The statistics are modest and real.** A Welch t-interval on the difference
of two means — Welch rather than Student because comparing nine Reels against
two hundred of everything else is the normal case here. Critical values come
from a lookup table rather than an approximation, and degrees of freedom round
*down*, which widens the interval. Every tie-break errs toward saying less.

**A segment is compared against the others, never the overall mean**, because
a segment is part of its own overall mean and comparing against it understates
every difference.

**Insufficient findings are stored, not discarded.** Knowing that a dimension
is under-sampled is useful and stops the same question being re-asked. They
are simply never rendered as conclusions: every display path and every brief
reads through `presentableFindings`.

**A missing metric excludes an observation rather than zeroing it.** §40's
rule reaches all the way here. An item whose follows were never captured is
not an item with zero follows, and feeding it in as zero would drag every
average toward a conclusion the content never earned.

**Hooks and posting times are bucketed coarsely** — six hook shapes, five time
slots. With dozens of posts rather than thousands, finer buckets would put
every segment below the minimum and the dimension would never say anything at
all.

## Consequences

The dashboard will say "nothing stands up yet" for months. That is correct,
and the copy says so explicitly rather than leaving it looking broken. Verified
against real data: one measured post produces twelve findings, all
`INSUFFICIENT_DATA`, none presentable.

A genuine effect will be called an OBSERVATION for a while before it is called
a HYPOTHESIS, and will never be called proven without an experiment. That
lag is the cost of not being wrong, and §29 asks for exactly it.

The brief composer only passes `SUPPORTED` and `HYPOTHESIS` findings to a
writer, and labels each with its sample size — so even the strongest signal
arrives as "worth testing", not as a rule.

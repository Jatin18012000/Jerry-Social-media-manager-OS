# 17. Pre-registered experiments

Status: Accepted — 2026-09-22

## Context

§29 caps observational analysis at `HYPOTHESIS`. However large the effect or
the sample, a pattern across posts you happened to publish is not a cause —
the posts were not assigned, so anything that influenced both the choice and
the outcome is indistinguishable from the thing being measured. ADR 0010 built
that ceiling deliberately, and `promoteWithExperiment` was left as the single
guarded door through it, called by nothing.

§30 is what opens that door: an experiment whose hypothesis, metric and
minimum sample size are fixed *before* the data exists.

**On scope.** §55 places experiments in V2, and §54 warns against building V2
inside V1. That conflict was raised rather than resolved quietly, and Jatin
authorised this on the explicit instruction "go ahead with the experiments
framework". It is recorded here because the next person to read §55 will
otherwise find this and reasonably conclude the rule was ignored.

## Decision

An experiment is a pre-registration plus two arms, and the pre-registration is
frozen the moment it starts. **There is no edit path** — the terms are written
once at creation and only read afterwards. An experiment whose metric can be
changed once the numbers arrive pre-registers nothing.

Six rules, each closing a specific way a pre-registered test degrades into an
observational one wearing its clothes.

**1. Nothing starts without complete terms.** A hypothesis long enough to be a
falsifiable claim, a metric the engine can actually compute, two named and
described arms, and a minimum sample size. Validated at *creation*, so an
experiment cannot sit in the list looking ready when it could never be
concluded. Every problem is reported at once — being told one at a time is a
poor way to find out there were four.

**2. Control and treatment, not arm A and arm B.** The treatment is what you
expect to win, so the direction of the claim is fixed in advance. An experiment
that does not say which way it expects the effect to go cannot be wrong: a
reversal gets read as a discovery. Naming the arms is what makes `REFUTED` a
possible outcome.

**3. The minimum sample size is per arm.** "n≥10" satisfied by a nine-one
split establishes nothing, and expressing the floor as a total invites exactly
that.

**4. No optional stopping.** An experiment cannot be concluded until *both*
arms reach the registered minimum, and the refusal says why in those words.
Stopping when the numbers happen to look right manufactures significance out
of noise, and it is the easiest of these rules to violate without noticing —
which is why it is a refusal in the use case and not a note in the UI. The
button is disabled as a courtesy; the server refusal is the mechanism.

**5. Assignment is closed at both ends.** An item may only join a `RUNNING`
experiment, so data cannot predate the terms. It cannot join a `CONCLUDED`
one, so data cannot postdate the verdict. It cannot move between arms. And —
the one this design initially missed, caught by a test — **an item that has
already been measured cannot join at all.** Its result is known, so enrolling
it is choosing a data point by its outcome: optional stopping performed at the
other end. `assignableItems` therefore offers unpublished items, because
assigning before publishing is the only order that yields data the experiment
did not select.

**6. A null result is a result.** `REFUTED` and `INCONCLUSIVE` are stored on
the experiment, surfaced in the list, and styled as findings rather than as
errors. An OS that can only conclude in favour of its own hypotheses is a
machine for confirming them, and §67 asks for the opposite. `REFUTED` is kept
distinct from `INCONCLUSIVE` for the same reason §7.3 keeps claim types
distinct: "the effect went the other way" and "we could not tell" are
different knowledge, and flattening them loses the more useful one.

One item may be in at most one *running* experiment. With a handful of posts a
week, two concurrent experiments over the same items confound both.

## Statistics

Welch's t-interval on the difference of the arm means — the same machinery
ADR 0010 already uses, for the same reason: it is honest about small samples,
which is the situation this account will be in for months.

- The interval excludes zero and treatment is ahead → `SUPPORTED`.
- The interval excludes zero and control is ahead → `REFUTED`.
- The interval includes zero → `INCONCLUSIVE`.

Confidence is governed by the **smaller** arm. An interval built on one arm of
six is confident about very little, however many are in the other.

A relative effect is declined when the baseline is effectively zero. Exact
zero is not the only unusable denominator: a control mean of 3e-8 yields
"150,499,900% higher", which is arithmetically correct and tells the reader
nothing. So a baseline below one percent of the larger arm is treated as zero
and the two means are reported instead. The verdict never depends on this —
it comes from the interval, which does not care how near zero either mean is.

## `SUPPORTED` findings survive recomputation

`recomputeFindings` replaces the whole stored set for a metric, so that the
dashboard never shows yesterday's finding beside today's. A `SUPPORTED`
finding is not a product of that recomputation, and the delete would have
destroyed every experimental result the moment new analytics arrived — the one
status that costs an experiment to obtain.

So `learning_findings.experiment_id` was added, the delete is scoped to rows
where it is null, and the column also gives every `SUPPORTED` finding a link
back to the terms that earned it. Two tests hold this down: one that the
finding survives a recompute, one that observational findings are still
replaced rather than accumulated.

## Consequences

- `promoteWithExperiment` is still the only route to `SUPPORTED`, and now has
  exactly one caller. Writing the status directly remains impossible.
- Assignment is manual. No traffic splitting, no sequential testing, no
  multi-arm correction — those need volume this account does not have, and
  each would be a way to be wrong faster.
- Two arms only. A third would need a multiple-comparison correction to mean
  anything, and adding arms without one would make the framework worse than
  no framework.
- The flywheel closes: a `HYPOTHESIS` finding on the Analytics page links
  into a pre-registration carrying its wording, and a concluded experiment
  links back. That path — notice, test, know — is what §67 asks the system to
  do, and it was the piece that did not exist.
- An experiment with an unreadable arm definition is shown as unusable rather
  than hidden. It cannot be concluded on any terms, and silence would be the
  wrong way to say so.

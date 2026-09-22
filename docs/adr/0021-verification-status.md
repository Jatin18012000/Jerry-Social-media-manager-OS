# 21. Verification status semantics

Status: Accepted — 2026-09-22

## Context

Most of this system's external integrations have never run against the real
thing. Vendor documentation domains are unreachable from the development
sandbox, and no feed has ever been fetched live. Fixtures prove the parser
handles the shape it was given; they prove nothing about the shape the
internet actually sends.

The risk is not that things are unverified — that is expected at this stage.
The risk is that "tested" quietly comes to mean "verified", and a confident
status table becomes the thing nobody re-checks.

## Decision

Every external integration carries exactly one of four labels, and the labels
are not used casually.

| Label | Means | Evidence required |
|---|---|---|
| **VERIFIED LIVE** | Exercised against the real external thing | An actual run, with its output |
| **VERIFIED DOCUMENTATION** | Behaviour confirmed from the vendor's own primary documentation | The documented statement and its source URL |
| **FIXTURE-TESTED ONLY** | Code correct against recorded fixtures; never run against the real thing | — (this is the honest default for a parser) |
| **UNVERIFIED** | Neither exercised nor confirmed | — |

**Rules:**

1. Nothing moves to a verified state without the evidence named above.
2. A blog post, a memory, or a plausible-looking constant is not documentation.
   `PLATFORM_LIMITS` is hardcoded and currently **UNVERIFIED** despite a code
   comment once describing the numbers as "documented" — that comment was the
   failure this ADR exists to prevent.
3. Partial evidence does not promote. A source poll returning
   `connection reset` proves the network path executes and is blocked; it is
   **not** evidence that feed parsing works, and does not move that row.
4. `VERIFIED DOCUMENTATION` is weaker than `VERIFIED LIVE` and says so.
   Platforms change; documentation lags.
5. A downgrade needs no ceremony. If something breaks, it goes back to
   `UNVERIFIED`.

The current status table lives in `P0_LAUNCH_READINESS.md` §5, with the
manual validation procedures that would change each row in §8.

## Consequences

- "All tests pass" never implies an integration works. Most of this system's
  external surface is `FIXTURE-TESTED ONLY` and the table says so.
- Statuses can only be changed by someone with access to the real thing —
  which for now means Jatin's machine, not this environment.

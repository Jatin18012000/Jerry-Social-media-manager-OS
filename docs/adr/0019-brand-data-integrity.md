# 19. Brand configuration integrity

Status: Accepted — 2026-09-22 (Product decision, P0)

## Context

A production brand voice was once created here by accident. A verification run
submitted the settings form; the payload was built as
`{ ...PLACEHOLDER_BRAND, ...form fields, isPlaceholder: false }`, so it
inherited placeholder content field by field and was stored flagged as real.

The consequence was not cosmetic. Every brief afterwards was written in a
voice nobody authored, and the "brand voice not yet defined" warning was
silently suppressed — §57 Risk 1 firing with its own alarm disabled, and §5
violated at the same time, because engineering had in effect set brand
strategy.

§4 assigns brand voice to Jatin and ChatGPT. The failure was not that someone
wrote a bad brand voice; it was that *nobody wrote one* and the system
presented one anyway.

## Decision

**Saving and activating are separate acts.**

`saveBrandDraft` stores an inactive version. A draft changes no brief, so
saving is safe in a way activating is not. `activateBrandVersion` is the only
place `active` is ever set true, and it requires:

- a **named actor** — §4 makes this a human decision, and an unattributed
  decision is a side effect;
- an **explicit confirmation** — a form submission alone cannot put a voice
  into use.

**Nothing defaults.** A production brand is validated against
`productionBrandSchema`, which has no defaults at all and requires
`isPlaceholder` to be literally `false`. A blank field is a validation
failure, not an empty string quietly stored. The `...PLACEHOLDER_BRAND` spread
is gone from every write path.

**The form starts empty** while the placeholder is in use. Prefilling it with
placeholder text puts engineering-authored words in front of the person whose
job it is to write the real ones, and accepting a prefill is how a voice
nobody wrote comes into use. A *real* brand is prefilled, because then it is
Jatin's own text being edited.

**Re-validated at activation, not only at save.** A row could have been
written by something other than `saveBrandDraft`, and activation is the gate
that decides what every brief is written in.

**Audited.** Activation writes a `system_events` record with version, actor
and timestamp, inside the same transaction as the activation, so a brand
cannot become active without the record of who made it so. The row itself
carries `activated_by` and `activated_at`, and the brand screen shows
placeholder-vs-real, active version, actor and time.

## What was considered and rejected

A database `CHECK` constraint asserting that a non-placeholder active row must
have an `activated_by`. SQLite cannot add a table-level `CHECK` without
rebuilding the table, and P0 required additive migrations only. Defence in
depth here would have meant a destructive migration to prevent a failure the
use case already prevents. Stated rather than silently skipped: if the
constraint is wanted later, it needs a planned table rebuild.

## Consequences

- No agent, script, fixture or form can activate a production brand as a side
  effect. Seeding writes no brand configuration at all, asserted by a test.
- The system stays in `BRAND VOICE UNDEFINED` until a named human activates a
  complete definition.
- Nine required fields, including at least one example line — the single most
  useful field for generation quality. A "real" voice without one is a
  placeholder wearing a name.
- Prohibited tone/claims and human-vs-AI-character rules are **not** yet
  fields on the brand config. The character rule is recorded as a product rule
  (ADR 0020) and enforced by `mayClaimRealExperience()`. Whether they should
  also become stored, enforceable brand fields is an open product question.

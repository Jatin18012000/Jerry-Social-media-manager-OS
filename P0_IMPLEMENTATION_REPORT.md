# P0 — Implementation Report

**From:** Claude Code (CTO / Principal Engineer)
**To:** ChatGPT (Product / Strategy owner), Jatin (final authority)
**Date:** 22 September 2026
**Branch:** `claude/determined-cray-skq5bg`
**Scope:** Steps 1–5 of the approved P0 execution order. Nothing else.

**Status: complete. Stopped as instructed, pending Product Owner review.**

---

## 1. Files changed

**New (12)**

| File | Purpose |
|---|---|
| `src/application/pillars.ts` | Pillar assignment use cases |
| `src/application/pillars.test.ts` | 19 tests (G, I, J) |
| `src/app/research/pillar-actions.ts` | Server actions for pillar assignment |
| `src/app/research/pillar-controls.tsx` | Pillar UI components |
| `src/db/migration.test.ts` | 8 tests (H) — migrations applied to populated databases |
| `src/domain/attribution.test.ts` | 12 tests (K) — follower attribution |
| `drizzle/0003_nosy_king_cobra.sql` | Brand integrity columns |
| `drizzle/0004_colorful_pretty_boy.sql` | Research pillar schema |
| `docs/adr/0018-experiments-shelved-for-launch.md` | |
| `docs/adr/0019-brand-data-integrity.md` | |
| `docs/adr/0020-research-pillars-and-attribution.md` | |
| `docs/adr/0021-verification-status.md` | |

**Modified (25)** — 1,403 insertions, 196 deletions.

Brand: `src/domain/brand.ts`, `src/application/brand.ts`,
`src/application/brand-actions.ts`, `src/app/settings/brand/page.tsx`,
`src/app/settings/brand/controls.tsx`, `src/application/brand.test.ts`.
Experiments: `src/config/env.ts`, `src/application/experiments.ts`,
`src/application/experiments.test.ts`, `src/app/experiments/page.tsx`,
`src/app/nav.tsx`, `src/app/analytics/page.tsx`.
Pillars: `src/db/schema.ts`, `src/application/ingest.ts`,
`src/application/ingest.test.ts`, `src/app/research/page.tsx`.
Attribution: `src/domain/metrics-parse.ts`, `src/application/analytics.ts`.
Maintenance and docs: `src/db/clean.ts`, `src/db/clean.test.ts`,
`src/app/globals.css`, `.env.example`, `README.md`,
`docs/adr/0016-obsidian-projection.md`, `drizzle/meta/_journal.json`.

---

## 2. Schema changes

Both migrations are **additive**, asserted by tests rather than claimed.

**`0003` — brand integrity**
```sql
ALTER TABLE brand_config ADD is_placeholder integer DEFAULT true NOT NULL;
ALTER TABLE brand_config ADD activated_by text;
ALTER TABLE brand_config ADD activated_at integer;
```
A pre-existing brand row defaults to `is_placeholder = 1`: it has no recorded
human behind it, and treating it as real would assume one.

**`0004` — research pillars**
```sql
CREATE TABLE research_item_pillars (
  research_item_id integer NOT NULL,
  pillar_id        integer NOT NULL,
  assigned_by      text    NOT NULL,
  assigned_at      integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (research_item_id, pillar_id),
  FOREIGN KEY ... );
ALTER TABLE research_items ADD primary_pillar_id integer REFERENCES content_pillars(id);
CREATE INDEX research_items_pillar_idx ON research_items (primary_pillar_id);
```

No `DROP`, no column removal, no table rebuild — asserted directly against the
SQL text, and separately by applying each migration to a database already
holding research items and claims and checking the data survives.

`assigned_by` is `NOT NULL` because a secondary pillar with no assigner is
indistinguishable from the machine guess this design refuses to make.

---

## 3. Domain changes

- **`productionBrandSchema`** — strict shape for a real brand voice. No
  defaults anywhere; `isPlaceholder` must be literally `false`. A blank field
  is a validation failure, not an empty string quietly stored.
- **`metricAllowedForPlatform` / `disallowedMetricsFor`** — the per-platform
  post-level attribution boundary, previously private to the parser, now the
  single place that question is answered so the parser and manual entry cannot
  disagree.
- **Unchanged, deliberately:** `mayClaimRealExperience()` (§51),
  `promoteWithExperiment()` (§30), the §38 state machine, and every §29
  threshold. No safety, provenance or state-machine guarantee was touched.

---

## 4. UI changes

**Brand** — provenance panel (placeholder-vs-real, active version, actor,
activation time); `BRAND VOICE UNDEFINED` stated prominently; form **starts
empty** while the placeholder is in use; separate "Drafts not in use" section
with per-version activation requiring a typed name.

**Experiments** — nav entry hidden while shelved; `/experiments` explains it
is parked, why, and that §29 is unchanged; the "Test this deliberately" link
on `HYPOTHESIS` findings is hidden rather than leading to a page that refuses.

**Research** — Pillars panel with per-pillar counts and an Unclassified
filter; per-item primary pillar picker with an explicit "Unclassified"
option; human-assigned secondary pillars shown with their assigner and a
remove control.

---

## 5. ADRs

| ADR | Content |
|---|---|
| 0016 (amended) | Approved future Obsidian import path; importer may never write content state |
| 0018 (new) | Experiments shelved; what shelving does *not* touch |
| 0019 (new) | Brand integrity; includes what was rejected and why |
| 0020 (new) | Research pillars, the AI character rule, follower attribution |
| 0021 (new) | Verification-status semantics and promotion rules |

---

## 6. Tests added

**65 new tests. Total 1,184, up from 1,119.**

| Req | Proof | Where |
|---|---|---|
| A | Placeholder cannot silently become real — no activation on save; every omitted or empty field refused; `PLACEHOLDER_BRAND` itself refused as production | `brand.test.ts` |
| B | Seed writes no brand configuration at all; no path activates as a side effect of saving | `brand.test.ts` |
| C | Activation refused without a named actor; refused without explicit confirmation; re-validated at activation | `brand.test.ts` |
| D | Activation audited with version, actor, timestamp; no audit record when refused | `brand.test.ts` |
| E | Create and start refused while `SHELVED`; nothing written; reading and concluding still work | `experiments.test.ts` |
| F | Full existing experiment suite retained and passing with `ACTIVE` | `experiments.test.ts` |
| G | Primary pillar may be `NULL`; reported as unclassified, never as a pillar; clearable back to unclassified | `pillars.test.ts` |
| H | Migrations applied to a **populated** database; rows, values and claim provenance survive; SQL asserted additive | `migration.test.ts` |
| I | Secondaries record their assigner; unattributed refused; own primary refused; idempotent | `pillars.test.ts` |
| J | Unclassified stays unclassified; no fifth "Other" pillar invented | `pillars.test.ts` |
| K | Metrics a platform does not report per post are not parsed **and** not accepted manually; absent follows never zero; observational data never reaches SUPPORTED | `attribution.test.ts` |

Also: ingestion persists the classifier's primary pillar, and stores `NULL`
when none could be determined (`ingest.test.ts`).

**No existing test was weakened to make a new one pass.** Two files changed
shape for reasons stated in §11.

---

## 7–10. Results

| Gate | Result |
|---|---|
| Unit + integration tests | **1,184 passed, 39 files, 0 failed** |
| Typecheck (`tsc --noEmit`) | **clean** |
| Lint (`eslint .`) | **clean** |
| Production build | **compiled successfully** |

**Verified in the running application**, not only in tests: all twelve routes
render with **zero page errors**; experiments hidden from nav and `/experiments`
explaining itself; brand form empty with `BRAND VOICE UNDEFINED`; a draft
saved through the real form and confirmed **not** activated (`active = 0` in
the database); activation through the UI with a typed name producing
"Active: version 1, activated by jatin"; a primary pillar set and a secondary
assigned through the real UI, rendering as `ALSO AI NEWS & UPDATES · JATIN ×`;
pillar filters returning the right items.

---

## 11. Deviations and judgement calls

**Nothing was built outside Steps 1–5.** Every item on the stop list remains
unbuilt.

**11.1 — Two existing test files changed shape.** `brand.test.ts` asserted
that saving activates. That behaviour was *removed by product decision*, so
the tests were rewritten against the two-phase API rather than weakened. The
experiment suite now passes `{ shelved: false }` explicitly, which is the
requirement that the infrastructure stay proven (F) rather than skipped.

**11.2 — A database `CHECK` constraint was considered and rejected.** Asserting
in SQL that a real active brand must have an `activated_by` would require
rebuilding the table, which SQLite cannot do additively — conflicting with
"no destructive migration". Enforcement is in the use case as instructed.
Stated rather than silently skipped: if the constraint is wanted, it needs a
planned rebuild.

**11.3 — The brand form no longer prefills from the placeholder.** Not in the
instruction. I judged it in scope for "do not allow engineering defaults to
silently become real brand configuration": prefilling puts
engineering-authored text in front of the person writing the real voice, and
accepting a prefill is how a voice nobody wrote comes into use. A *real* brand
still prefills, because then it is Jatin's own text being edited.

**11.4 — `saveReading` now enforces the attribution boundary.** Not explicitly
listed, but decision 7 says "never attribute unless the platform explicitly
provides post-level attribution", and manual entry could previously bypass the
allow-list the OCR path already respected. Closing it is the decision, not an
extension of it.

**11.5 — Prohibited tone/claims and human-vs-AI rules were NOT added as brand
fields.** The character rule is locked as a product rule and recorded in ADR
0020; `mayClaimRealExperience()` enforces it and is unchanged. Adding stored
fields would have been a schema decision not asked for. **Open question in
§14.**

**11.6 — Two bugs I introduced and fixed during verification.** Both found by
running the app, not by tests:
- Invalid HTML — a `<form>` nested in a `<p>` in the pillar UI, producing a
  React hydration error. Fixed; all routes now render with zero page errors.
- `db:clean` broke on the new `research_item_pillars` foreign key. It **failed
  loudly** rather than half-cleaning, which is what the transaction is for.
  Fixed, with two tests added.

**11.7 — I created and activated a test brand during verification, then
removed it.** This is the same failure class as the original incident and I am
reporting it rather than quietly cleaning up. Three things are worth noting:
the safeguards *worked* — it required a deliberate, typed, named activation
and could not happen as a side effect; it was **fully auditable**, and I can
show exactly what happened and when from `system_events`; and `db:clean --brand`
removed it. The database is back to zero brand rows. `BRAND VOICE UNDEFINED`
is preserved, verified directly against the database.

---

## 12. Remaining launch blockers

| # | Blocker | Owner | Severity |
|---|---|---|---|
| 1 | **Brand voice undefined** | ChatGPT + Jatin | **HIGH** — every brief generic; §57 Risk 1 live |
| 2 | **`PLATFORM_LIMITS` unverified** and acting as QA blockers | Jatin (V2) | **HIGH** — wrong numbers reject valid content or pass invalid |
| 3 | No feed ever fetched live | Jatin (V1) | **MEDIUM** |
| 4 | Which platforms report post-level follows is unverified | Jatin | **MEDIUM** — the attribution allow-list rests on it |
| 5 | LinkedIn Page + developer app | Jatin | **MEDIUM** — publishing stays manual |
| 6 | Meta developer app + App Review | Jatin | **MEDIUM** — as above |
| 7 | No verified `OLLAMA_MODEL` tag | Jatin (V3) | **LOW** — heuristics are a supported configuration |
| 8 | Tesseract path never executed | Jatin (V4) | **LOW** — paste-only is verified and legitimate |

---

## 13. Exact actions required from Jatin

Run on the MacBook, in this order. Procedures in `P0_LAUNCH_READINESS.md` §8.

1. **`git pull`, then `npm run db:migrate`.** Two additive migrations. Safe on
   a populated database — proven by test, but take a copy of `data/os.db`
   first anyway.
2. **`npm run db:clean`** if the database holds demo data. Read what it says
   before using `--brand`.
3. **V1 — live feed validation.** `npm run dev` → `/research` → *Poll
   sources*. Send the System page source table and the resulting research
   list. This is the single highest-value action available: it moves four
   integrations off `FIXTURE-TESTED ONLY` and would expose any real-world
   parsing failure before content depends on it.
4. **V2 — platform limits.** Instagram and LinkedIn caption character maximums
   and hashtag maximums, **from the platforms' own documentation**, with
   source URLs. Also whether either reports **follows for an individual
   post** — that determines blocker 4.
5. **V3 — `ollama list`.** Send the exact output.
6. **V4 — Tesseract**, only if the automated OCR path is wanted. Paste-only is
   already verified and is a legitimate answer.
7. **Brand voice**, once ChatGPT supplies it (§14). Enter it at
   `/settings/brand`, save as draft, review, then activate with your name.
   Saving alone does nothing.

---

## 14. Exact actions required from ChatGPT / Product

**14.1 — Supply the brand definition.** Nine required fields: brand name,
positioning, primary audience, secondary audience, language policy, voice
traits, does, avoids, and **at least one example line**. All are mandatory;
the form refuses a partial definition, and example lines matter most for
generation quality. This is blocker 1 and nothing downstream improves without
it.

**14.2 — Prohibited tone and claims (P0 §3.6).** Still undefined. Engineering
will not author it.

**14.3 — Decide whether prohibited claims and character rules become stored
brand fields.** Per 11.5 they are currently a documented rule enforced in the
domain, not configuration. Making them configurable would let the QA gate
enforce them mechanically per brand version; leaving them as code means they
change only by deployment. **This is a product decision and I have not made
it.**

**14.4 — Confirm the cadence targets are not queue quotas.** Implemented as
stated: targets, never a reason to publish weak content. No code currently
counts toward a daily number, and I did not build queue planning around the
targets — P0 did not ask for it. Say if you want it.

**14.5 — Note on experiment re-enablement.** Shelving is one environment
variable. When cadence and volume support it, `EXPERIMENTS_MODE=ACTIVE`
restores the feature with no migration and no code change.

---

## 15. Definition of done

| Criterion | Status |
|---|---|
| Product decisions encoded correctly | ✅ Steps 1–4 |
| Brand explicitly undefined until approved | ✅ verified against the database |
| Research supports pillar classification | ✅ primary + human-assigned secondaries |
| Experiments safely shelved | ✅ gated in the use case, infrastructure intact |
| Obsidian remains one-way | ✅ unchanged; future path documented |
| Live vs fixture verification distinguished | ✅ ADR 0021 + P0 §5 |
| Launch blockers documented | ✅ §12 |
| Implementation report exists | ✅ this document |
| No unnecessary architecture introduced | ✅ no new dependency, service or database |
| Tests remain green | ✅ 1,184 passing |
| No safety/provenance/state-machine guarantee weakened | ✅ §29, §30, §40, §51 and the §38 machine untouched |

**Stopping here as instructed.** No further feature work until Product Owner
review.

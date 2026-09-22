# P0 — Product & Launch Readiness

**Phase:** Product-direction lock → launch preparation
**Prepared by:** Claude Code (CTO / Principal Engineer)
**For:** ChatGPT (Product / Strategy owner), Jatin (final authority)
**Date:** 22 September 2026
**Build:** branch `claude/determined-cray-skq5bg`, 1,119 tests passing, typecheck / lint / production build clean

> **This document is a plan, not an implementation.** No code has been written
> against these decisions. Section 11 proposes the execution order; nothing in
> it starts until the Product Owner approves.

---

## 1. Current system state

### 1.1 What is built and working

M0–M6 complete, each verified in the running application rather than only in
tests. The loop closes end to end: research → verified claims → brief →
generation → QA → human approval → schedule → publish → measure → learn →
into the next brief.

| Area | State |
|---|---|
| Research ingestion (RSS/Atom, arXiv, HN, manual URL) | Built; **fixture-tested only** |
| Dedupe, claim extraction, provenance | Built and tested |
| Opportunities, brief composer, paste-back parser | Built and verified |
| QA gate, approval queue (§22) | Built and verified |
| Scheduler, manual publish, publication records (§39, §40) | Built and verified |
| Analytics capture (paste), north-star metric | Built and verified |
| Learning engine, tiered findings (§29) | Built and verified |
| Experiments (§30) | Built and verified; **to be shelved — see 2.1** |
| LAN authentication (§41) | Built and verified |
| Notifications (§47) | Built and verified |
| Obsidian one-way projection | Built and verified |
| System observability page (§43) | Built and verified |
| `db:clean` maintenance | Built and verified |

Seventeen ADRs in `docs/adr/`.

### 1.2 Architectural invariants currently enforced

These are enforced in code, not by convention, and none of the work below
weakens any of them:

- **§22** — `SCHEDULED` reachable only from `APPROVED`, in the domain.
- **§39** — four independent layers against double-publishing.
- **§40** — no `PUBLISHED` without external ID or named human confirmation;
  absent metrics are `NULL` everywhere, never `0`.
- **§29** — observational analysis cannot reach `SUPPORTED`.
- **§7.3** — six claim types stay distinct wherever shown.
- **§7.1** — model-proposed claims are ground-checked against source text.
- **§65** — `src/domain/**` and `src/ports/**` cannot import DB, framework or
  adapter; enforced by ESLint.

### 1.3 Current database state

Development database holds **only seeded configuration**: 4 content pillars,
11 sources. All demo and test data removed; autoincrement counters reset.
**No brand configuration exists** — the system is in the correct
`BRAND VOICE UNDEFINED` state.

---

## 2. Decisions received and how they will be encoded

### 2.1 Experiments — SHELVED, not deleted

**Decision:** shelve active experimentation for initial launch. Keep the
infrastructure. Initial phase runs OBSERVE → MEASURE → LEARN → HYPOTHESIZE.

**Encoding:** a single configuration value, `EXPERIMENTS_MODE=SHELVED|ACTIVE`,
defaulting to `SHELVED`, in `src/config/env.ts` alongside the other mode
switches (§64 pattern — mode selection is configuration, not code).

When `SHELVED`:
- the Experiments nav entry is hidden;
- `/experiments` renders an explanatory page rather than 404 — the feature is
  deliberately parked, and a dead link reads like a bug;
- creating or starting an experiment is refused in the **use case**, not only
  in the UI.

**What does not change:** §29's ceiling stays exactly as built. Observational
findings still stop at `HYPOTHESIS`. `promoteWithExperiment` remains the only
route to `SUPPORTED`, and with experiments shelved that route is simply not
exercised — which is the correct meaning of "do not claim causal conclusions
from observational data". Shelving removes the *ability to run experiments*;
it does not lower the bar for concluding without one.

**No dead code:** every module stays reachable, tested and typechecked. The
mode gates behaviour, not compilation.

### 2.2 Research pillars — PRIMARY + OPTIONAL SECONDARY

**Decision:** pillars apply to research as well as content, as one primary
plus optional secondaries, across the four approved pillars.

**Current gap:** the classifier already decides a pillar for every research
item and **ingestion discards it** — `research_items` has no pillar column.
This is the change with the largest blast radius in this phase, so it is
staged deliberately (see 11, Steps 3–4).

**Proposed encoding:**
- `research_items.primary_pillar_id` — nullable FK to `content_pillars`.
- `research_item_pillars` — join table for secondaries, `(research_item_id,
  pillar_id)` primary key, mirroring the existing `opportunity_research`
  shape. A join table rather than columns, because "optional secondaries"
  is a set of unknown size and a fixed `secondary_1 / secondary_2` would be
  the wrong model on the first item that spans three.

**Migration safety** (explicitly required): additive only — a nullable column
and a new table. No existing column changes type, nothing is dropped, no
existing row becomes invalid. Existing research items get `NULL` primary
pillar, which reads as "not classified" and is honest: they were ingested
before classification was retained, and back-dating a pillar would be
inventing one. Ingestion and provenance paths are untouched. Generated with
`npm run db:generate`, never hand-written SQL.

**Open question this raises — see 3.1.** The classifier returns exactly one
pillar. Nothing currently produces secondaries.

### 2.3 Obsidian — remains one-way

**Decision:** keep as a one-way projection; no importer now; document the
intended future architecture.

**Encoding:** no code change. This is already true by construction — there is
no read path into the database, and that absence is the guarantee. ADR 0016
will be extended with the approved future path:

```
Obsidian note → SourceFetcher → dedupe → provenance → claims
              → verification → research item
```

with the constraint recorded explicitly: **an Obsidian importer may never
write content state.** It may only produce research items that then travel the
normal §16 provenance and §7.2 verification path like any other source.

### 2.4 Brand voice — remains explicitly undefined

**Decision:** system stays in `BRAND VOICE UNDEFINED` until the Product Owner
supplies and approves a definition. Engineering must not invent, infer, or let
defaults become real. See section 6 for the full requirement and the specific
safeguards.

### 2.5 Scheduling — unchanged

**Decision:** MacBook is not a guaranteed scheduler; missed windows surface as
`MISSED` for human action; never publish late; n8n stays deferred.

**Encoding:** no change. This is current behaviour.

### 2.6 Architecture — locked

**Decision:** TypeScript + Next.js + SQLite, local-first, single deployable
application. No microservices, Python services, Kubernetes, Redis, Kafka,
external workflow engines, paid SaaS or additional databases.

**Encoding:** no change, and nothing proposed in section 11 introduces any of
these. Provider abstraction (`src/ports/`) stays intact and is what makes
Claude / Gemini / Ollama swappable by configuration.

---

## 3. Remaining product decisions — ENGINEERING CANNOT DECIDE THESE

Per the operating rule, these are stated rather than silently chosen. Each
gives options, technical consequence, and a recommendation where useful.

### 3.1 How are SECONDARY pillars assigned? — **blocks Step 4**

The classifier (local model or heuristics) returns exactly **one** pillar.
Nothing in the system currently produces a secondary.

| Option | Consequence |
|---|---|
| **A. Human only** | Secondaries exist but stay empty until Jatin sets them in the research UI. Zero invention risk. Slowest to populate. |
| **B. Heuristic** | Any pillar whose keyword score passes a threshold becomes secondary. Deterministic and explainable, but the threshold is a product judgement about how broadly a story "counts". |
| **C. Local model** | Ask Qwen for primary + secondaries. Richer, but multi-label output is harder to validate and a hallucinated pillar is a silent miscategorisation that skews pillar analytics. |

**Recommendation: A for launch, with B as a follow-up once real pillar data
exists.** Pillar-level analytics is one of the stated reasons for this change,
and seeding it with machine guesses would corrupt the very measurement it
exists to enable. Human-assigned secondaries are few but trustworthy.

**Needed from Product Owner:** choose A, B or C.

### 3.2 What happens when no pillar fits? — **blocks Step 3**

| Option | Consequence |
|---|---|
| **A. `NULL` = unclassified** | Honest; item still usable; pillar analytics excludes it. |
| **B. Force nearest pillar** | Every item counted; **violates §7.1** by inventing a classification. |

**Recommendation: A.** Stated for confirmation rather than debate, because it
determines whether the column is nullable and that is hard to change later.

### 3.3 Backfill existing research items? — **affects Step 4**

Existing rows will have `NULL` primary pillar. Options: leave them (pillar
analytics covers only post-change items, and says so), or run classification
retroactively (fuller data, but the classification is machine-assigned and
carries 3.1's invention risk at scale).

**Recommendation: leave them NULL for launch.** The current database has no
real research items anyway — this only matters if the decision is deferred
past first ingestion.

### 3.4 Initial cadence — **blocks launch checklist section B**

Posts per week, per platform. Not in the PRD and not in the decisions
received. Needed because it determines whether the `MISSED` window and the
review queue are sized sensibly, and whether experiments would ever have been
viable (they would not, at low cadence — which supports 2.1).

### 3.5 Platform adaptation rules — **blocks launch checklist section B**

Does one opportunity always produce both an Instagram and a LinkedIn variant,
or is that per-opportunity judgement? Affects the default variant creation
path only; no architectural consequence either way.

### 3.6 Prohibited tone and claims — **blocks launch checklist section A**

The QA gate can enforce prohibitions mechanically (banned phrases, claim types
that may not appear) but **the list is a brand decision**. Engineering will not
author it.

### 3.7 Human vs AI-character rules (§51) — **blocks launch checklist section A**

`mayClaimRealExperience()` already exists in the domain. What it should permit
is a brand decision: may content claim first-person experience Jatin has not
had? Under what character mode?

### 3.8 Analytics attribution rules — **blocks launch checklist section E**

"Attribution rules" was listed in the required checklist but is not defined
anywhere in the PRD or the decisions. Engineering's reading is: how follows
are attributed to a post, given the platform reports account-level follows
rather than per-post. **This needs a definition before it can be encoded**, and
the §40 rule means an unattributable follow must stay unattributed rather than
be assigned by assumption.

---

## 4. Remaining engineering blockers

Ordered by risk to launch correctness.

### 4.1 `PLATFORM_LIMITS` are unverified vendor facts — **HIGH**

`src/domain/qa.ts` hardcodes Instagram 2,200 chars / 30 hashtags, LinkedIn
3,000 / 30, YouTube Shorts 5,000 / 15, Facebook 5,000 / 30. The comment
describes them as "documented, long-standing platform constraints" — **I could
not verify that, because vendor documentation domains are blocked from this
environment.** They currently act as **QA blockers**, so a wrong number either
rejects valid content or lets over-length content through to a manual post.

This is exactly the "do not hardcode vendor behavior based on assumptions"
case. Manual validation procedure in section 8.

### 4.2 Brand form inherits placeholder content — **HIGH**

`src/application/brand-actions.ts` builds the saved config as
`{ ...PLACEHOLDER_BRAND, ...form fields, isPlaceholder: false }`. Today every
field is overridden, so nothing leaks. But **the moment a field is added to
`BrandConfig` and not to the form, it will silently inherit placeholder text
and be stored marked as real.** That is the precise mechanism of the incident
already reported. Fix in Step 2.

### 4.3 Demo and real data are indistinguishable — **HIGH**

No column, flag or convention separates seeded/demo rows from real ones.
`db:clean` currently identifies demo sources by URL, which works but is a
heuristic. The brand incident is the general case of this. Fix in Step 2.

### 4.4 Configuration changes are only partly auditable — **MEDIUM**

Brand config is versioned (good) and `systemEvents` records some changes. But
there is no single audit trail answering "what configuration changed, when,
and by whom". Minimum viable fix in Step 2.

### 4.5 Tesseract OCR path never executed — **MEDIUM**

`src/adapters/ocr/index.ts` already documents this honestly: the Tesseract
path has not been exercised, because this environment is Linux with no
tesseract installed. The pasted-text path is the one that has been verified.

### 4.6 No live feed has ever been fetched — **MEDIUM**

See section 5.

---

## 5. External integration blockers and verification status

Per the required marking scheme. **Nothing moves out of `UNVERIFIED` or
`FIXTURE-TESTED ONLY` without evidence.**

| Integration | Status | Notes |
|---|---|---|
| Obsidian vault write | **VERIFIED LIVE** | Real filesystem, real files, create/update/merge/orphan-report all exercised |
| Manual publisher | **VERIFIED LIVE** | Full path through the running app |
| LAN authentication | **VERIFIED LIVE** | Session mint, middleware gate, fail-closed on missing secret |
| SQLite + migrations | **VERIFIED LIVE** | Migrations applied to a real database |
| RSS / Atom fetch | **FIXTURE-TESTED ONLY** | Parser correct against fixtures; never run against a live feed |
| arXiv fetch | **FIXTURE-TESTED ONLY** | As above |
| Hacker News fetch | **FIXTURE-TESTED ONLY** | As above |
| Manual URL fetch | **FIXTURE-TESTED ONLY** | As above |
| Platform limits (IG/LI/YT/FB) | **UNVERIFIED** | Hardcoded; vendor docs unreachable — see 4.1 |
| Ollama / Qwen | **UNVERIFIED** | No confirmed model tag; heuristics are what actually runs |
| Tesseract OCR | **UNVERIFIED** | Command shape never executed |
| Instagram API | **UNVERIFIED** | Not built; blocked on Meta developer app |
| LinkedIn API | **UNVERIFIED** | Not built; blocked on Page + developer app |

One observation worth recording precisely: a source poll attempted from this
environment returned `connection reset` for TechCrunch. That is evidence the
network path executes and is blocked — **it is not evidence that feed parsing
works against real data.** It does not change any status above.

---

## 6. Brand configuration requirements

The system must present `BRAND VOICE UNDEFINED` until the Product Owner
supplies **all** of the following. Engineering will not draft, infer or
suggest any of it.

**Required:**

1. Brand name
2. Positioning — one sentence, what this account is *for*
3. Primary audience
4. Secondary audience
5. Language policy — English / Hindi / Hinglish, and when each applies
6. Voice traits — the adjectives that constrain output
7. Voice "does" — concrete behaviours, not aspirations
8. Voice "avoids" — concrete behaviours
9. Example lines — real lines in the voice; the single most useful field for
   generation quality
10. Prohibited tone and claims (3.6)
11. Human vs AI-character rules (3.7)

**Optional:** character definition, design system.

**Safeguards to be added (Step 2), minimum necessary, no overengineering:**

- **Placeholder cannot be inherited.** Remove the `...PLACEHOLDER_BRAND`
  spread; require every field explicitly. A missing field becomes a validation
  error rather than silent placeholder text.
- **Real brand requires explicit human confirmation.** Activating a
  non-placeholder brand requires a deliberate confirmation step, so it cannot
  be a side effect of a form submission or an automated call.
- **No agent may activate a production brand.** Seeds, demo scripts and
  fixtures are barred from writing a config with `isPlaceholder: false`,
  enforced in the use case so no script path can bypass it.
- **Auditability.** Every brand activation writes a `systemEvent` recording
  version, actor and timestamp, in addition to existing row versioning.
- **Visible provenance.** The brand screen states which version is active,
  when it was activated, and whether it is placeholder or real.

---

## 7. Launch checklist

Legend: **[E]** engineering-owned · **[P]** product-owned · **[J]** Jatin
manual action

### A. Brand — **blocking**
- [P] Brand identity, positioning, primary + secondary audience
- [P] Tone and voice (traits / does / avoids / example lines)
- [P] Prohibited tone and claims (3.6)
- [P] Human vs AI-character rules (3.7)
- [E] Safeguards from section 6 in place
- [J] Brand definition entered and confirmed at `/settings/brand`

### B. Content
- [P] Four approved pillars confirmed (done — no new pillars without approval)
- [P] Formats per platform
- [P] Initial cadence (3.4)
- [P] Platform adaptation rules (3.5)
- [E] Approval requirement enforced (done — §22)

### C. Research
- [E] Source classes seeded (done — 10 sources + manual bucket)
- [E] Provenance at claim granularity (done — §16)
- [E] Verification workflow (done — §7.2 tiers)
- [J] **Live-source validation** (section 8) — currently fixture-only
- [E] Stale-source handling — `lastError` surfaced on System page (done)
- [E] Claim extraction with groundedness checking (done)
- [E] Pillar classification on research (Steps 3–4)

### D. Platforms
- [E] Manual publishing path (done, verified)
- [J] Instagram: Meta developer app, Facebook Page link, App Review
- [J] LinkedIn: Page + developer app
- [E] Publisher port ready for API implementations (done)
- [E] Platform limits verified (4.1) — **currently unverified**

### E. Analytics
- [E] Required metrics captured (done)
- [E] Paste capture with confirm step (done, verified)
- [J] Tesseract path validated, or accept paste-only (4.5)
- [E] NULL handling — absent never zero (done, enforced end to end)
- [P] Attribution rules (3.8) — **undefined**

### F. AI
- [E] Claude — engineering only; no generation API spend (D3)
- [P] Gemini — visual production; role confirmed, not yet integrated
- [P] ChatGPT — strategy; operates outside the system
- [J] Ollama/Qwen — confirm a real model tag (`ollama list`)
- [E] Provider abstraction intact (done — `src/ports/`)
- [E] No invented capabilities (done — §7.1 enforced, incl. groundedness)

### G. Security
- [E] No secrets in Git (done — §41, `.env.local` ignored)
- [E] LAN authentication, fail-closed (done, verified)
- [E] Timing-safe passphrase comparison (done)
- [J] OAuth credentials — **not yet applicable**; to be encrypted at rest via
      macOS Keychain when platform access exists. **Not implemented** — no
      credentials exist yet
- [E] Auditability of configuration changes (Step 2)

### H. Reliability
- [E] Duplicate publishing prevention (done — four layers)
- [E] Failed job handling and retry with cap (done)
- [E] Missed schedule surfacing (done — never publishes late)
- [E] Laptop sleep tolerated by design (done — D2)
- [E] Manual recovery paths (done — edit, reschedule, cancel)

---

## 8. Local / manual validation checklist — for Jatin, on the MacBook

These cannot be performed from the development environment. Each states what
evidence would move an item out of `UNVERIFIED` / `FIXTURE-TESTED ONLY`.

### V1 — Live feed validation *(moves four rows to VERIFIED LIVE)*

```bash
npm run db:migrate && npm run db:seed
npm run dev
```

Open `/research` → **Poll sources**. Then record, per source:

1. Did it fetch without error? (System page shows `lastError` if not)
2. Were items created with correct title, URL and published date?
3. Did arXiv and Hacker News return items in the expected shape?
4. Did a second poll create duplicates, or correctly dedupe?

**Evidence needed:** the System page source table showing `polled` timestamps
with no errors, plus a research list with real items. Send that and the
statuses change; without it they do not.

### V2 — Platform limits *(resolves 4.1)*

From primary sources only — the Instagram and LinkedIn help/developer
documentation, not a blog post:

- Instagram caption maximum characters, and hashtag maximum
- LinkedIn post maximum characters, and hashtag maximum

**Evidence needed:** the documented numbers with their source URLs. If they
differ from `PLATFORM_LIMITS`, engineering corrects the code; if the limits
cannot be confirmed, they should be relaxed to warnings rather than blockers,
because a wrong blocker rejects valid content.

### V3 — Ollama model tag *(resolves the Ollama row)*

```bash
ollama list
```

Send the exact output. `OLLAMA_MODEL` will be set to a tag that machine
actually reports — never to a guessed name.

### V4 — Tesseract, if the automated OCR path is wanted *(resolves 4.5)*

```bash
brew install tesseract
tesseract --version
tesseract screenshot.png stdout
```

Send the output for one real Instagram insights screenshot. If this is not
wanted, the decision is simply "paste-only", which is already verified — and
that is a legitimate answer, not a gap.

### V5 — Manual publish dry run

Take one item through the full loop to `PUBLISHED` using the manual publisher,
then capture metrics by paste. Confirms the end-to-end path on real hardware
before any real content depends on it.

---

## 9. Risks

| # | Risk | Severity | Status / mitigation |
|---|---|---|---|
| R1 | Generic output because brand voice is undefined (§57 Risk 1) | **HIGH** | Warning on every brief and the dashboard; blocked on Product Owner |
| R2 | Research error published as fact (§57 Risk 2) | **HIGH** | Claim types, evidence tiers, groundedness checking, unverified claims block progress |
| R3 | Unverified vendor limits reject valid content or pass invalid | **HIGH** | Open — 4.1, validation V2 |
| R4 | Demo/test data mistaken for real | **HIGH** | Partially mitigated by `db:clean`; safeguards in Step 2. **This has already happened once** |
| R5 | Fetchers fail against real feeds despite passing fixtures | **MEDIUM** | Open — validation V1 |
| R6 | Causal claim from observational data | **MEDIUM** | Mitigated structurally; unchanged by shelving experiments |
| R7 | Missed schedule from laptop sleep | **MEDIUM** | Accepted by D2; surfaced, never published late |
| R8 | Pillar migration disrupts ingestion | **MEDIUM** | Additive migration only; staged in Steps 3–4; existing rows stay valid |
| R9 | Double publish | **LOW** | Four independent layers |
| R10 | Platform API access never granted | **MEDIUM** | Manual publishing is the designed V1 path, not a fallback |

---

## 10. What we should NOT build yet

Explicitly out of scope for P0. Listed so it is on record that their absence
is a decision, not an oversight.

1. **Obsidian importer** — decided; future architecture documented only.
2. **Active experimentation** — shelved; infrastructure retained.
3. **New content pillars** — four only, no additions without approval.
4. **Instagram / LinkedIn API publishers** — blocked on access; `Publisher`
   port is ready.
5. **n8n or any external workflow engine** — deferred; no concrete
   requirement the current scheduler cannot meet.
6. **Gemini integration** — role agreed, not needed for first content cycle.
7. **Paid AI generation (Anthropic/Gemini APIs)** — D3 holds; brief is the
   product.
8. **Multi-user, roles, permissions** — single-user system.
9. **Cloud deployment, containers, external databases** — architecture locked.
10. **Model-assigned secondary pillars** — pending 3.1.
11. **Automated brand-voice suggestion** — forbidden by §4/§5, permanently.
12. **Retroactive pillar backfill** — pending 3.3.
13. **Scheduler redundancy / always-on host** — D2 stands.
14. **Vault deletion of orphaned notes** — report only; deletion stays manual.

---

## 11. Recommended execution order

Sequenced so that **nothing that could corrupt real data ships after real data
exists**, and so each step is independently verifiable and revertible.

### STEP 0 — Product Owner approves this plan *(blocking)*
Answer 3.1 and 3.2 at minimum; they block Steps 3 and 4. Everything else can
proceed in parallel with the remaining answers.
**Output:** go/no-go plus decisions.

### STEP 1 — Shelve experiments *(no data risk)*
Add `EXPERIMENTS_MODE`, default `SHELVED`. Hide nav, explain the parked route,
refuse create/start in the use case. §29's ceiling untouched.
**Done when:** experiments unreachable in default config, all existing tests
still green, no module orphaned.

### STEP 2 — Brand and data-integrity safeguards *(highest value, do before real data)*
Remove the placeholder spread; require explicit confirmation for a real brand;
bar seed/demo/fixture paths from writing `isPlaceholder: false`; audit brand
activation to `systemEvents`; show provenance on the brand screen.
**Done when:** a placeholder cannot become real by accident, no script path can
activate a production brand, and a test asserts both.
**Rationale for ordering:** this is the one already-realised failure (R4), and
its value is highest *before* a real brand is entered.

### STEP 3 — Research pillar: data model *(schema only)*
Additive migration: nullable `primary_pillar_id`, `research_item_pillars` join
table. Persist the classifier's existing primary pillar at ingestion. No UI.
**Done when:** migration applies cleanly to a populated database, existing rows
remain valid, ingestion and provenance tests unchanged and green.
**Blocked on:** 3.2.

### STEP 4 — Research pillar: UI and filtering
Show pillar on the research list, filter by pillar, allow human assignment of
primary and secondaries per 3.1's answer.
**Done when:** research is filterable by pillar and pillar-level counts are
visible.
**Blocked on:** 3.1.

### STEP 5 — Documentation of locked decisions
ADR for the shelving decision and the brand safeguards; extend ADR 0016 with
the approved future Obsidian architecture; record the verification-status
scheme so it is maintained rather than a one-off.
**Done when:** every decision in section 2 has a durable record.

### STEP 6 — Hand the validation checklist to Jatin
Section 8, V1–V5. Engineering cannot progress these; they gate several launch
items and should start as early as possible since they need real hardware.

### STEP 7 — Correct anything V1–V5 disproves
Most likely `PLATFORM_LIMITS` (V2) and feed parsing (V1). Statuses change only
on evidence.

### STEP 8 — Report back to ChatGPT, then stop
Per the operating rule, no further major feature before review.

**Not in this sequence, deliberately:** anything from section 10.

---

## 12. Definition of done for P0

| Criterion | Met by |
|---|---|
| Product decisions encoded correctly | Steps 1–4 |
| Brand explicitly undefined until approved | Step 2 + current state (no config exists) |
| Research supports pillar classification | Steps 3–4 |
| Experiments safely shelved | Step 1 |
| Obsidian remains one-way | No change; documented in Step 5 |
| Live vs fixture verification distinguished | Section 5; maintained per Step 5 |
| Launch blockers documented | Sections 3, 4, 5, 7 |
| This document exists | Done |
| No unnecessary architecture introduced | Nothing in Steps 1–8 adds a dependency or service |
| Tests remain green | Gate on every step |
| No safety/provenance/state-machine guarantee weakened | Explicit non-goal of every step |

---

## Engineering's position

The build is not the constraint. **Brand voice is**, and after it, real-world
validation that only Jatin's machine can perform. Steps 1–5 are roughly a day
of careful work; Steps 6–7 depend entirely on inputs engineering cannot
produce.

The one thing I would push back on if this were open: nothing here improves
content quality. It makes the system *correct* and *honest* about what it
knows. Quality arrives with section 6, and no amount of engineering
substitutes for it.

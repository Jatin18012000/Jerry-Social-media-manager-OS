# Social Media OS

A human-controlled, AI-powered social media operating system: research →
verify → create → approve → schedule → publish → measure → learn.

The product specification lives outside this repository (Master PRD v1.0).
Section references throughout the code (`§22`, `§39`, …) point at it. Where
code enforces a PRD rule, the comment says which rule and why it is enforced
where it is.

**Status: M5 — the flywheel closes.** Research → verified claims → brief →
generation → QA → human approval → schedule → publish → measure → learn →
back into the next brief. Publishing is manual until platform access clears.
See _Milestones_ below.

---

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env.local     # then set SESSION_SECRET and APP_PASSPHRASE
npm run db:migrate
npm run dev                    # http://localhost:3000
```

`npm run dev` binds to `0.0.0.0` so the dashboard is reachable from an iPad or
iPhone on the same network (§46).

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server, LAN-accessible |
| `npm run build` | Production build |
| `npm test` | Run the test suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the architectural boundary rule |
| `npm run check` | typecheck + lint + test — run this before committing |
| `npm run db:generate` | Generate SQL migrations from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed the §10 pillars and the §14 starting source list |
| `npm run db:demo` | Insert one worked example through the whole loop (dev only) |
| `npm run db:clean` | Remove demo/test data, keeping §10 pillars and §14 sources |

---

## Architecture

```
src/app/          UI (Next.js App Router)
src/application/  Use cases and server actions. Owns transactions.
src/adapters/     Concrete implementations of ports (fetchers, HTTP)
src/config/       Environment and mode selection (§64)
src/ports/        Interfaces — the only way external services enter
src/domain/       Entities, state machine, invariants. Depends on nothing.
src/db/           SQLite schema and client (Drizzle)
```

**The rule that holds it together:** `src/domain/**` and `src/ports/**` may not
import the database, a framework, or an adapter. This is PRD §65 (no vendor
lock-in), and it is enforced by an ESLint rule rather than by discipline —
see `eslint.config.mjs`.

### Every manual seam is an interface an API can later fill

V1 runs free and local, with a human at three points. Each of those is an
implementation of a port, not a special case:

| Port | V1 | Later |
|---|---|---|
| `AIProvider` | `ManualProvider` — brief out, paste in | `AnthropicProvider`, `GeminiProvider` |
| `Publisher` | `ManualPublisher` | `LinkedInPublisher`, `InstagramPublisher` |
| `AnalyticsSource` | pasted text / Tesseract OCR | `InstagramInsightsSource` |
| `StructuredProvider` | `OllamaProvider` (local Qwen), else heuristics | any hosted model |

Switching is configuration (`src/config/env.ts`), not a rewrite. That is §64's
`MODE=FOUNDATION | PRODUCTION` migration path.

### Invariants are enforced in depth

Two PRD rules are not recoverable if broken — content published without human
approval, and content marked published that never was. Each is enforced at
more than one level:

| Rule | Domain | Database |
|---|---|---|
| §22 no publishing without approval | `SCHEDULED` reachable only from `APPROVED` | — |
| §40 nothing published without evidence | guard on entering `PUBLISHED` | `CHECK` on `publication_records` |
| §39 no double publishing | idempotency key | `UNIQUE(content_item_id, platform)` |
| §7.2 verified claims cite evidence | `mayBeStatedAsFact()` | `CHECK` on `claims` |
| §16 unverified claims block progress | guard on entering `STRATEGY_READY` | — |
| §39 one job per item/platform/slot | idempotency key + atomic job claim | `UNIQUE(idempotency_key)` |
| §29 no conclusions from small samples | tiered findings; `SUPPORTED` needs an experiment | — |
| §30 no conclusion before the registered n | refused per arm, in the use case | — |

The domain guards can be bypassed by a bug. The database constraints cannot.

---

## Milestones

| M | Scope | Status |
|---|---|---|
| **M0** | Scaffold, schema, migrations, state machine, ADRs | ✅ done |
| **M1** | Research ingestion: RSS, arXiv, Hacker News, manual URL drop; dedupe, claims, provenance | ✅ done |
| **M2** | Opportunities, brief composer, paste-back parser | ✅ done |
| **M3** | QA gate, approval queue, scheduler, manual publish, publication records | ✅ done |
| **M4** | OCR analytics capture, north-star metric | ✅ done |
| **M5** | Learning engine, findings, dashboard | ✅ done |
| **M6** | Pre-registered experiments (§30) — the only route to SUPPORTED | ✅ done (shelved for launch) |
| **P0** | Launch readiness: brand integrity, research pillars, verification status | ✅ done |
| M7+ | `LinkedInPublisher`, then `InstagramPublisher` | blocked on platform access |

M1–M6 have no external dependencies and do not wait on platform API access.

---

## Security

The app binds to `0.0.0.0` so an iPad can reach it (§46) — which means every
device on the network can reach it. "Local network" is not a security
boundary, and §22's approval gate is worthless if anyone on the wifi can click
Approve.

- **Authentication is required to run the app.** `SESSION_SECRET` (32+ chars)
  and `APP_PASSPHRASE` must both be set. Middleware runs on every route and
  fails closed: a missing secret redirects to a page explaining the
  misconfiguration rather than serving the app.
- Sessions are an expiry signed with HMAC-SHA256. The signature is verified
  before the expiry is trusted, so a rewritten cookie cannot extend itself.
- The passphrase comparison is timing-safe.
- No secrets in this repository. `.env.local` is git-ignored; `.env.example`
  documents the shape (§41).
- The local database and generated media are git-ignored — they are machine
  state, not source.
- Platform OAuth tokens will be encrypted at rest with a key from the macOS
  Keychain, not stored beside the database. **Not yet implemented** — no
  platform credentials exist yet.

## Local model (optional)

Pillar, relevance and language classification prefer a local model over
keyword matching. Set `OLLAMA_MODEL` to a tag `ollama list` reports on your
machine and point `OLLAMA_BASE_URL` at the daemon.

Leaving it unset is a supported configuration, not a degraded one — the
deterministic heuristics are what runs by default, and they keep running when
the daemon is down, the model is mid-download or a request times out. Every
attempt is recorded in `agent_runs` either way, so whether the model is
actually being used is a question the data answers.

The model also proposes claims. Every proposed claim is checked against the
source text and dropped if it is not there: numbers must appear in the source
exactly, and a reworded claim must match a single source sentence rather than
the text as a whole. A claim is stored with its source's name and evidence
tier and later shown to a writer as fact, so an invented one would arrive
wearing a primary source's authority — §57 Risk 2. Drops are recorded as
`UNGROUNDED` runs and visible on the System page.

The model is never trusted to produce the right shape either. Its output is
parsed and then validated; an invented pillar, an out-of-range score, an
unknown language or a seventh claim type all fall back rather than getting
through.

## Experiments

**Shelved for the initial launch phase** (`EXPERIMENTS_MODE=SHELVED`, the
default). The first content cycle runs observe → measure → learn →
hypothesise; at the current cadence a two-armed experiment costs ten posts.
Nothing is deleted — the infrastructure stays compiled and tested, and
`ACTIVE` restores it. §29's ceiling is unchanged either way: shelving removes
the ability to run an experiment, not the bar for concluding without one.

When active, `/experiments` is the only route to a `SUPPORTED` finding. Observational
analysis stops at `HYPOTHESIS` (§29) — a pattern across posts you happened to
publish is not a cause. §30 opens that door by fixing the hypothesis, the
metric, the two arms and the minimum sample size *before* the posts go out.

Once an experiment starts there is no edit path, and it cannot be concluded
until **both** arms reach the registered minimum. Stopping when the numbers
look right manufactures significance out of noise, so that is a refusal in the
use case, not a warning in the UI. An item that has already been measured
cannot be enrolled at all: its result is known, so choosing it would mean
choosing a data point by its outcome.

A null result is a result. `REFUTED` and `INCONCLUSIVE` are recorded and shown
— "the effect went the other way" and "we could not tell" are kept distinct,
and neither is treated as a failed run. Only `SUPPORTED` earns a finding, and
it links back to the terms that produced it.

A `HYPOTHESIS` finding on the Analytics page links straight into a
pre-registration carrying its wording. That path — notice, test, know — is
what §67 asks for.

## Obsidian (optional)

Set `OBSIDIAN_VAULT_PATH` and the System page can project research,
opportunities and published posts into a vault as Markdown, with frontmatter
and wikilinks.

It is one-way. There is no importer anywhere in the system, which is how the
database stays the system of record — the vault cannot speak back. Notes are
disposable: delete the folder, export again, nothing is lost. Anything written
below the generated marker in a note survives every re-export, so the notes
are also somewhere to think.

Leaving it unset writes nothing and is a supported configuration.

**Orphan notes.** Because the export never deletes, a note whose row has since
been removed stays in the vault pointing at nothing. The System page lists
those notes, by path, and the export reports a count. It deletes none of them:
a projection that reached back into your vault could destroy a note you had
moved or rewritten, so that decision stays yours. Files you added yourself, and
notes of ours you renamed, are not counted — only names matching `{id}-{slug}.md`
are treated as ours.

Orphans are judged against the whole database, not against the last export.
The export is capped, so comparing against one batch would call every note
beyond the cap an orphan and invite deleting notes whose rows are intact.

### Clearing demo data

`npm run db:demo` leaves research, opportunities, content, publications and
analytics that look exactly like real work on every screen. `npm run db:clean`
removes all of it and keeps the §10 pillars and the §14 source list, which are
configuration rather than demo data. Sources are matched by URL, not by row id
— ids shift as rows come and go.

The brand configuration is kept by default: §4 makes it Jatin's and ChatGPT's
deliverable, and a cleanup script must not be able to destroy work this
repository cannot regenerate. If one is set that is not the placeholder, the
command says so — a brand voice nobody wrote silently suppresses the warning
that output is generic. `npm run db:clean -- --brand` removes it.

It also rewinds the `AUTOINCREMENT` counters, so a cleaned database hands out
ids from 1 again rather than from the hundreds. Each counter is set to the
largest id that actually survived — dropped entirely for an emptied table,
left accurate for one that kept rows. SQLite takes the next id as
`max(largest existing rowid, sequence) + 1`, so this cannot collide with a
surviving row, and a test inserts for real to prove it.

One consequence worth knowing: ids are reused after a clean, and Obsidian
notes are named `{id}-{slug}.md`. Notes exported before a clean stay in the
vault as orphans pointing at deleted rows. The System page lists them (see
below), and the tidy move is to delete the `Social Media OS/` folder and
re-export.

## Research pillars

Every research item carries a **primary pillar**, which the classifier may
propose at ingestion and a human may correct, plus optional **secondary
pillars** which are human-assigned only — no model and no heuristic writes
them, and each records who assigned it. Early pillar analytics is worth having
only if it is trustworthy.

An item fitting none of the four approved pillars is `NULL`, shown as
**UNCLASSIFIED**. It is not pushed into the nearest pillar and there is no
fifth "Other" bucket; counts report it separately rather than folding it into
a pillar it does not belong to.

## Verification status

External integrations are labelled `VERIFIED LIVE`, `VERIFIED DOCUMENTATION`,
`FIXTURE-TESTED ONLY` or `UNVERIFIED`, and nothing is promoted without
evidence. Most of this system's external surface is fixture-tested only: no
feed has ever been fetched live from the development environment. The current
table is in [`P0_LAUNCH_READINESS.md`](P0_LAUNCH_READINESS.md) §5, and ADR 0021
defines what each label requires.

## What still needs a human

- **Brand voice** (`/settings/brand`). §4 makes this ChatGPT's and Jatin's
  deliverable, not engineering's. Until it is set, every brief carries a
  warning and output stays generic — §57 Risk 1.
- **Platform access.** A LinkedIn Page and developer app; a Meta developer app
  and, if required, App Review. Publishing is manual until these exist.

## Decisions

Architecture decision records are in [`docs/adr/`](docs/adr). Product
documentation lives outside this repository.

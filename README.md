# Social Media OS

A human-controlled, AI-powered social media operating system: research →
verify → create → approve → schedule → publish → measure → learn.

The product specification lives outside this repository (Master PRD v1.0).
Section references throughout the code (`§22`, `§39`, …) point at it. Where
code enforces a PRD rule, the comment says which rule and why it is enforced
where it is.

**Status: M3 — approval, scheduling and publishing.** The core loop is
closed end to end: research → verified claims → brief → generation → QA →
human approval → schedule → publish. Publishing is manual until platform
access clears. See _Milestones_ below.

---

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env.local     # then fill in SESSION_SECRET
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
| `AnalyticsSource` | `OcrAnalyticsSource` | `InstagramInsightsSource` |

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

The domain guards can be bypassed by a bug. The database constraints cannot.

---

## Milestones

| M | Scope | Status |
|---|---|---|
| **M0** | Scaffold, schema, migrations, state machine, ADRs | ✅ done |
| **M1** | Research ingestion: RSS, arXiv, Hacker News, manual URL drop; dedupe, claims, provenance | ✅ done |
| **M2** | Opportunities, brief composer, paste-back parser | ✅ done |
| **M3** | QA gate, approval queue, scheduler, manual publish, publication records | ✅ done |
| M4 | OCR analytics ingestion | next |
| M5 | Learning engine and dashboard | |
| M6+ | `LinkedInPublisher`, then `InstagramPublisher` when platform access clears | |

M1–M5 have no external dependencies and do not wait on platform API access.

---

## Security

- No secrets in this repository. `.env.local` is git-ignored; `.env.example`
  documents the shape (§41).
- The local database and generated media are git-ignored — they are machine
  state, not source.
- `SESSION_SECRET` is required because the app binds to the LAN.
- Platform OAuth tokens will be encrypted at rest with a key from the macOS
  Keychain, not stored beside the database.

## Decisions

Architecture decision records are in [`docs/adr/`](docs/adr). Product
documentation lives outside this repository.

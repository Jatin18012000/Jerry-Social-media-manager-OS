# Jatin Personal AI Social Media OS

Durable project rules. Read before changing anything.

## Source of truth

- **Master PRD v1.0 governs.** It lives outside this repository. Section marks
  throughout the code (`§22`, `§39`, …) point at it.
- Never silently reinterpret a requirement. If new information conflicts with
  the PRD, **say so and propose the smallest safe change** — do not implement
  the conflict away.
- The database is the system of record for content state, approvals,
  schedules and analytics. No other system may become authoritative.

## Agents

| Agent | Owns |
|---|---|
| Jatin | Brand, judgement, approval, final authority |
| ChatGPT | Strategy, product direction, quality challenge |
| Claude / Claude Code | Engineering, architecture, implementation, testing, docs |
| Gemini | Visual and creative production |
| Qwen via Ollama | Local worker for repetitive classification. Not a strategic brain. |

Engineering must not set product strategy (§5). Brand voice, positioning and
pillars come from Jatin and ChatGPT — this codebase stores and versions them,
and proposes none of it.

## Decisions already made (binding)

| # | Decision | Consequence |
|---|---|---|
| D1 | Manual publishing first | Real platform APIs slot in behind `Publisher` |
| D2 | MacBook-only, LAN, ₹0 | Jobs overdue past grace are `MISSED`, never fired late |
| D3 | Human-in-the-loop generation | The brief is the product; no AI API spend |
| D4 | Screenshot → local OCR → confirm | Metrics are proposed, never written unconfirmed |
| D5 | RSS + arXiv/HN + manual URL drop | Manual drop covers X, which has no free tier |
| D6 | TypeScript, Next.js, SQLite | One runtime, one process |

**n8n is deferred**, not rejected. The OS already owns scheduling and
publishing with four layers of double-publish protection; a second scheduler
would make §39 a property of whichever one ran. Revisit when there is a
concrete job the OS cannot do — most likely notifications (§47). If it is
added, it triggers and transports; it does not own state.

## Architecture

```
src/app/          UI (Next.js App Router)
src/application/  Use cases and server actions. Owns transactions.
src/adapters/     Concrete implementations of ports
src/config/       Environment and mode selection (§64)
src/ports/        Interfaces — the only way external services enter
src/domain/       Entities, state machine, invariants. Depends on nothing.
src/db/           SQLite schema and client (Drizzle)
src/lib/          Cross-cutting primitives with no domain knowledge
```

**The rule that holds it together:** `src/domain/**` and `src/ports/**` may not
import the database, a framework, or an adapter. This is §65, and it is
enforced by an ESLint rule rather than by discipline. If you need something
external in the domain, define a port.

Every external dependency enters through a port. Model providers, publishers,
analytics sources, fetchers and notifiers are all replaceable, and switching
between them is configuration (`src/config/env.ts`), not code.

## Rules that must not be weakened

These are not style preferences. Each protects something unrecoverable.

- **§22 — nothing publishes without human approval.** `SCHEDULED` is reachable
  only from `APPROVED`, enforced in the domain where no UI bug can bypass it.
- **§39 — nothing publishes twice.** Idempotency key, atomic job claim,
  `UNIQUE(content_item_id, platform)`, and a domain guard. Four layers,
  because a double post is public and cannot be undone.
- **§40 — nothing is marked published without evidence.** An external ID or a
  named human confirmation. A publisher that cannot know does not say.
- **§40 — never fabricate a metric.** Absent is `NULL`, never `0`, all the way
  from the parser through the aggregates to the UI. "Not reported" and
  "reported as zero" are different facts.
- **§7.1 — never invent** sources, statistics, API capabilities, model
  behaviour or platform rules. Verify against official documentation, and say
  "I could not verify this" rather than guessing (§7.4).
- **§7.3 — never flatten claim types.** Fact, inference, assumption, estimate,
  opinion and prediction stay distinct everywhere they are shown.
- **§29 — never claim causation from observation.** Below the minimum sample
  size a finding is `INSUFFICIENT_DATA` and is never rendered as a conclusion.
  Only a pre-registered experiment (§30) reaches `SUPPORTED`.
- **§41 — no secrets in Git**, and the app refuses to serve without
  authentication because it binds to the LAN.

## How to work

Understand → Plan → Build → Test → Verify → Document → Commit.

- Do not jump from a vague request to a large change. Inspect what exists,
  name the affected components, present a plan.
- Small, reversible steps. One milestone at a time.
- **Run `npm run check` before committing** — typecheck, lint and tests.
- Verify in the running application, not only in tests (§62 step 5).
- Record architectural decisions in `docs/adr/`.
- Prefer official APIs. Never build core publishing on scraping, password
  automation or fragile browser clicking (§25).
- Avoid unnecessary dependencies and unnecessary services (§54).

### Testing

- Tests must not touch the network. Inject the HTTP client and use fixtures.
- Test the failure paths, not just the happy one. Most of the rules above are
  only real because a test asserts they hold.
- When a test fails, work out whether the code or the expectation is wrong
  before changing either.

## Environment constraints

Some documentation domains (Meta, Google, Microsoft, Anthropic, and likely
others) are **blocked from the development sandbox**. Vendor facts cannot be
verified from here, which §7.2 and the Definition of Done both require.

When that happens: label the claim as unverified, say which primary source
needs checking, and do not hardcode anything that depends on it. A model tag,
an API endpoint or a rate limit taken from a blog post is a guess.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server, LAN-accessible |
| `npm run check` | typecheck + lint + test — run before committing |
| `npm test` | Tests only |
| `npm run db:generate` | Generate SQL migrations from the schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed §10 pillars and the §14 source list |
| `npm run db:demo` | One worked example through the whole loop (dev only) |

## The rule behind all of it

> Do not build a machine that produces content. Build a machine that learns
> how to produce better content. — §67

When a change would make the system produce more and learn less, it is the
wrong change.

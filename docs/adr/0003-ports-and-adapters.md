# 3. Ports and adapters for provider independence

Status: Accepted — 2026-09-21

## Context

PRD §35 requires that no model or provider is hard-coded into the application,
and §65 is a hard rule against depending fundamentally on Claude, Gemini,
ChatGPT, Supabase or Vercel. §66 states that the OS provides orchestration,
memory, workflow, scheduling, analytics and learning — AI providers are
dependencies, not the product.

Separately, V1 runs with a human at three points: generation, publishing and
analytics capture. The naive approach would treat those as temporary hacks to
be replaced later.

## Decision

Define ports (`src/ports/`) as interfaces: `AIProvider`, `Publisher`,
`AnalyticsSource`, `SourceFetcher`, `Notifier`. Domain and application code
depend on these types only.

Treat each manual V1 seam as a first-class implementation of its port rather
than a stopgap: `ManualProvider`, `ManualPublisher`, `OcrAnalyticsSource`.
Selection happens in `src/config/env.ts` from environment variables.

Enforce the boundary with an ESLint `no-restricted-imports` rule over
`src/domain/**` and `src/ports/**`. A boundary maintained only by discipline
erodes.

## Consequences

Adding an API key later changes configuration, not code — which is what makes
the user's zero-cost V1 decision cost them nothing in future optionality.

The price is indirection: reading how content is generated means reading an
interface and then an implementation. For a system whose entire premise is
replaceable providers, that is the right trade.

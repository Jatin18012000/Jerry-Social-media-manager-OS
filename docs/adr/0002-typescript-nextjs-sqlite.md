# 2. TypeScript end-to-end, Next.js and SQLite

Status: Accepted — 2026-09-21

## Context

PRD §37 leaves technology selection to architecture design. The binding
constraints were: runs on a MacBook over LAN, zero recurring cost (§32),
local-first (§34), a responsive approval interface that is good on Mac and
iPad (§46), local OCR and local models, no vendor lock-in (§65), and no
over-engineering (§54).

Python was the serious alternative — it is the more natural home for OCR,
local model bindings and future media processing (§49 live repurposing).

## Decision

TypeScript end-to-end: Next.js (App Router) with SQLite via `better-sqlite3`
and Drizzle ORM. One language, one runtime, one dependency tree, one process.

Local models are reached over Ollama's HTTP API and OCR through a CLI
invocation, so neither requires a Python runtime.

Drizzle was chosen over the alternatives because it is SQL-first with
file-based migrations, and the same schema definitions target Postgres. When
§64's move from FOUNDATION to PRODUCTION happens, SQLite → Postgres is a
migration concern, not an application rewrite.

## Consequences

The daily approval and brief-paste interface — the thing that is used most —
gets the better ecosystem. The cost is that heavy media and ML work in V2 will
either shell out to native tools or need a separate worker, which is a real
cost we accepted knowingly.

Chosen with the user rather than unilaterally, since §37 makes this the CTO's
call but it shapes everything they will maintain.

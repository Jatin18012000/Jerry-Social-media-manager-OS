/**
 * System health and usage — PRD §43 (observability), §44 (cost tracking),
 * §45 (the System section of the dashboard).
 *
 * Reads only. Its job is to answer questions that are otherwise matters of
 * belief: is the local model actually being used, is anything quietly
 * failing, what has this cost, which adapters are live.
 *
 * §44 wants cost per content piece and eventually cost per acquired follower.
 * Under decision D3 the answer is currently zero, and saying so with the data
 * behind it is more useful than omitting the section — it makes the day that
 * stops being true visible.
 */

import { and, desc, gte, sql } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  agentRuns,
  contentItems,
  costRecords,
  generations,
  sources,
  systemEvents,
} from '@/db/schema';

export interface AgentUsage {
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly runs: number;
  readonly failures: number;
  readonly avgDurationMs: number | null;
  readonly lastRunAt: number | null;
}

/**
 * Model and heuristic usage over a window.
 *
 * Grouped by agent rather than by operation because the question this answers
 * is "which worker is doing the work" — whether the local model is earning
 * its place or whether everything is quietly falling back to keywords.
 */
export function agentUsage(db: DB, sinceDays = 30): AgentUsage[] {
  const since = Date.now() - sinceDays * 86_400_000;

  return db
    .select({
      agent: agentRuns.agent,
      provider: agentRuns.provider,
      model: agentRuns.model,
      runs: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${agentRuns.status} <> 'OK' then 1 else 0 end)`,
      avgDurationMs: sql<number | null>`avg(${agentRuns.durationMs})`,
      lastRunAt: sql<number | null>`max(${agentRuns.createdAt})`,
    })
    .from(agentRuns)
    .where(gte(agentRuns.createdAt, since))
    .groupBy(agentRuns.agent, agentRuns.provider, agentRuns.model)
    .orderBy(sql`count(*) desc`)
    .all();
}

/** Recent failed model runs, with their errors. */
export function recentAgentFailures(db: DB, limit = 10) {
  return db
    .select()
    .from(agentRuns)
    .where(sql`${agentRuns.status} <> 'OK'`)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit)
    .all();
}

export interface CostSummary {
  readonly total: number;
  readonly currency: string;
  readonly records: number;
  readonly perContentItem: number | null;
  readonly windowDays: number;
}

/**
 * §44. Cost per content piece, which is the number that matters rather than
 * the total.
 */
export function costSummary(db: DB, sinceDays = 30): CostSummary {
  const since = Date.now() - sinceDays * 86_400_000;

  const totals = db
    .select({
      total: sql<number | null>`sum(${costRecords.amount})`,
      records: sql<number>`count(*)`,
      currency: sql<string | null>`max(${costRecords.currency})`,
    })
    .from(costRecords)
    .where(gte(costRecords.incurredAt, since))
    .get();

  const published = db
    .select({ n: sql<number>`count(*)` })
    .from(contentItems)
    .where(gte(contentItems.createdAt, since))
    .get();

  const total = totals?.total ?? 0;
  const items = published?.n ?? 0;

  return {
    total,
    currency: totals?.currency ?? 'USD',
    records: totals?.records ?? 0,
    // Null rather than zero when there is nothing to divide by: §40's rule
    // about absent versus zero applies to derived numbers too.
    perContentItem: items > 0 ? Number((total / items).toFixed(4)) : null,
    windowDays: sinceDays,
  };
}

/** Recent warnings and errors — §43. */
export function recentFailures(db: DB, sinceDays = 7, limit = 25) {
  const since = Date.now() - sinceDays * 86_400_000;

  return db
    .select()
    .from(systemEvents)
    .where(
      and(
        sql`${systemEvents.severity} in ('WARN','ERROR')`,
        gte(systemEvents.createdAt, since),
      ),
    )
    .orderBy(desc(systemEvents.createdAt))
    .limit(limit)
    .all();
}

export interface SourceHealth {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly lastPolledAt: number | null;
  readonly lastError: string | null;
  readonly credibilityTier: string;
}

export function sourceHealth(db: DB): SourceHealth[] {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      enabled: sources.enabled,
      lastPolledAt: sources.lastPolledAt,
      lastError: sources.lastError,
      credibilityTier: sources.credibilityTier,
    })
    .from(sources)
    .orderBy(sources.name)
    .all();
}

export interface Integration {
  readonly name: string;
  readonly mode: string;
  readonly live: boolean;
  readonly note: string;
}

/**
 * Which adapter is behind each port right now — §45 "Integrations".
 *
 * Reads configuration rather than probing, so the page renders instantly.
 * "Configured" is not "reachable": the local model's availability is checked
 * per request at use time, and `agent_runs` shows whether it actually answers.
 */
export function integrations(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Integration[] {
  const generation = env['AI_GENERATION_MODE'] ?? 'MANUAL';
  const publisher = env['PUBLISHER_MODE'] ?? 'MANUAL';
  const analytics = env['ANALYTICS_MODE'] ?? 'OCR';
  const ollamaModel = env['OLLAMA_MODEL'];

  return [
    {
      name: 'Content generation',
      mode: generation,
      live: generation !== 'MANUAL',
      note:
        generation === 'MANUAL'
          ? 'Brief out, paste in (decision D3). No AI API spend.'
          : 'Automated generation is enabled.',
    },
    {
      name: 'Publishing',
      mode: publisher,
      live: publisher !== 'MANUAL',
      note:
        publisher === 'MANUAL'
          ? 'Prepared for you to post by hand. Platform access not yet set up.'
          : 'Publishing through platform APIs.',
    },
    {
      name: 'Analytics capture',
      mode: analytics,
      live: analytics === 'API',
      note:
        analytics === 'API'
          ? 'Pulled from the platform API.'
          : 'Screenshot text pasted in and confirmed (decision D4).',
    },
    {
      name: 'Local model',
      mode: ollamaModel ?? 'not configured',
      live: Boolean(ollamaModel),
      note: ollamaModel
        ? 'Used for classification when reachable; heuristics otherwise.'
        : 'Classification runs on deterministic heuristics. This is a supported configuration.',
    },
  ];
}

export interface GenerationUsage {
  readonly mode: string;
  readonly provider: string | null;
  readonly runs: number;
  readonly parsedOk: number;
}

/** How generations have been arriving, and how often parsing worked (D3). */
export function generationUsage(db: DB, sinceDays = 30): GenerationUsage[] {
  const since = Date.now() - sinceDays * 86_400_000;

  return db
    .select({
      mode: generations.mode,
      provider: generations.provider,
      runs: sql<number>`count(*)`,
      parsedOk: sql<number>`sum(case when ${generations.parsedOk} then 1 else 0 end)`,
    })
    .from(generations)
    .where(gte(generations.createdAt, since))
    .groupBy(generations.mode, generations.provider)
    .all();
}

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  agentRuns,
  contentItems,
  costRecords,
  sources,
  systemEvents,
} from '@/db/schema';
import {
  agentUsage,
  costSummary,
  integrations,
  recentAgentFailures,
  recentFailures,
  sourceHealth,
} from './system';

let sqlite: Database.Database;
let db: DB;

function run(
  agent: string,
  status: string,
  opts: { model?: string; durationMs?: number; ageDays?: number } = {},
): void {
  db.insert(agentRuns)
    .values({
      agent,
      provider: agent === 'qwen' ? 'ollama' : 'local',
      model: opts.model ?? null,
      operation: 'classify-research',
      durationMs: opts.durationMs ?? 10,
      status,
      createdAt: Date.now() - (opts.ageDays ?? 0) * 86_400_000,
    })
    .run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('agentUsage', () => {
  it('groups by agent and model', () => {
    run('qwen', 'OK', { model: 'q3' });
    run('qwen', 'OK', { model: 'q3' });
    run('heuristic', 'OK');

    const usage = agentUsage(db);
    expect(usage.find((u) => u.agent === 'qwen')?.runs).toBe(2);
    expect(usage.find((u) => u.agent === 'heuristic')?.runs).toBe(1);
  });

  it('counts failures separately from runs', () => {
    run('qwen', 'OK', { model: 'q3' });
    run('qwen', 'INVALID_OUTPUT', { model: 'q3' });
    run('qwen', 'UNAVAILABLE', { model: 'q3' });

    const qwen = agentUsage(db).find((u) => u.agent === 'qwen');
    expect(qwen?.runs).toBe(3);
    expect(qwen?.failures).toBe(2);
  });

  it('shows the local model doing nothing when it always falls back', () => {
    // The question this page exists to answer: configured is not working.
    run('qwen', 'UNAVAILABLE', { model: 'q3' });
    run('heuristic', 'OK');
    run('qwen', 'UNAVAILABLE', { model: 'q3' });
    run('heuristic', 'OK');

    const usage = agentUsage(db);
    const qwen = usage.find((u) => u.agent === 'qwen');
    expect(qwen?.failures).toBe(qwen?.runs);
  });

  it('orders by run count, busiest first', () => {
    run('heuristic', 'OK');
    run('qwen', 'OK', { model: 'q3' });
    run('qwen', 'OK', { model: 'q3' });

    expect(agentUsage(db)[0]?.agent).toBe('qwen');
  });

  it('averages duration', () => {
    run('qwen', 'OK', { model: 'q3', durationMs: 100 });
    run('qwen', 'OK', { model: 'q3', durationMs: 200 });
    expect(agentUsage(db).find((u) => u.agent === 'qwen')?.avgDurationMs).toBe(
      150,
    );
  });

  it('excludes runs outside the window', () => {
    run('qwen', 'OK', { model: 'q3', ageDays: 60 });
    expect(agentUsage(db, 30)).toHaveLength(0);
  });

  it('returns nothing when nothing has run', () => {
    expect(agentUsage(db)).toEqual([]);
  });
});

describe('recentAgentFailures', () => {
  it('lists only failures', () => {
    run('qwen', 'OK', { model: 'q3' });
    run('qwen', 'ERROR', { model: 'q3' });

    const failures = recentAgentFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe('ERROR');
  });
});

describe('costSummary — PRD §44', () => {
  it('reports zero when nothing has been spent', () => {
    const cost = costSummary(db);
    expect(cost.total).toBe(0);
    expect(cost.records).toBe(0);
  });

  it('reports per-item cost as null with no items to divide by', () => {
    // §40's absent-versus-zero rule applies to derived numbers too: a cost
    // per item of 0 would imply items exist and were free.
    expect(costSummary(db).perContentItem).toBeNull();
  });

  it('computes cost per content item', () => {
    db.insert(contentItems)
      .values([
        { platform: 'INSTAGRAM', format: 'REEL' },
        { platform: 'LINKEDIN', format: 'TEXT' },
      ])
      .run();

    db.insert(costRecords)
      .values([
        { category: 'generation', amount: 1.0, currency: 'USD' },
        { category: 'generation', amount: 3.0, currency: 'USD' },
      ])
      .run();

    const cost = costSummary(db);
    expect(cost.total).toBe(4);
    expect(cost.perContentItem).toBe(2);
  });

  it('excludes costs outside the window', () => {
    db.insert(costRecords)
      .values({
        category: 'generation',
        amount: 5,
        incurredAt: Date.now() - 60 * 86_400_000,
      })
      .run();

    expect(costSummary(db, 30).total).toBe(0);
  });
});

describe('recentFailures', () => {
  it('includes warnings and errors but not info', () => {
    db.insert(systemEvents)
      .values([
        { kind: 'a', severity: 'INFO' },
        { kind: 'b', severity: 'WARN' },
        { kind: 'c', severity: 'ERROR' },
      ])
      .run();

    const kinds = recentFailures(db).map((e) => e.kind);
    expect(kinds).toContain('b');
    expect(kinds).toContain('c');
    expect(kinds).not.toContain('a');
  });

  it('excludes events outside the window', () => {
    db.insert(systemEvents)
      .values({
        kind: 'old',
        severity: 'ERROR',
        createdAt: Date.now() - 30 * 86_400_000,
      })
      .run();

    expect(recentFailures(db, 7)).toHaveLength(0);
  });
});

describe('sourceHealth', () => {
  it('reports a failing source with its error', () => {
    db.insert(sources)
      .values({
        name: 'Broken Feed',
        type: 'PUBLICATION',
        fetcher: 'RSS',
        url: 'https://example.com/x',
        credibilityTier: 'OTHER',
        lastError: 'connection reset',
      })
      .run();

    expect(sourceHealth(db)[0]?.lastError).toBe('connection reset');
  });
});

describe('integrations — PRD §45', () => {
  it('reports the V1 defaults honestly', () => {
    const adapters = integrations({});

    const generation = adapters.find((a) => a.name === 'Content generation');
    expect(generation?.mode).toBe('MANUAL');
    expect(generation?.live).toBe(false);

    const publishing = adapters.find((a) => a.name === 'Publishing');
    expect(publishing?.note).toContain('by hand');
  });

  it('calls an unconfigured local model a supported configuration', () => {
    // Not an error state. The heuristics are the default path.
    const local = integrations({}).find((a) => a.name === 'Local model');
    expect(local?.live).toBe(false);
    expect(local?.note).toContain('supported configuration');
  });

  it('reports the local model as live once configured', () => {
    const local = integrations({ OLLAMA_MODEL: 'qwen3' }).find(
      (a) => a.name === 'Local model',
    );
    expect(local?.live).toBe(true);
    expect(local?.mode).toBe('qwen3');
  });

  it('reports live publishing when switched on', () => {
    const publishing = integrations({ PUBLISHER_MODE: 'LIVE' }).find(
      (a) => a.name === 'Publishing',
    );
    expect(publishing?.live).toBe(true);
  });
});

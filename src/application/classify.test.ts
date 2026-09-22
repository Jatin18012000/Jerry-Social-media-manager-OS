import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { agentRuns, contentPillars } from '@/db/schema';
import type { StructuredProvider, StructuredRun } from '@/ports';
import {
  classifyResearchItem,
  classifyWithHeuristics,
  parseClassification,
} from './classify';

let sqlite: Database.Database;
let db: DB;

const SLUGS = ['ai-news', 'ai-research', 'ai-careers'];

/** A provider that returns whatever the test dictates. */
function stubProvider(
  output: unknown,
  opts: { available?: boolean; status?: StructuredRun<unknown>['status'] } = {},
): StructuredProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    available: async () => opts.available ?? true,
    run: async (task) => {
      const parsed = output === null ? null : task.parse(output);
      return {
        output: parsed,
        provider: 'stub',
        model: 'stub-model',
        durationMs: 5,
        status: parsed === null ? (opts.status ?? 'INVALID_OUTPUT') : 'OK',
      };
    },
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });

  db.insert(contentPillars)
    .values([
      {
        slug: 'ai-news',
        name: 'AI News',
        description: 'released, launch, announces, available',
      },
      {
        slug: 'ai-research',
        name: 'AI Research',
        description: 'paper, arxiv, benchmark, research',
      },
      {
        slug: 'ai-careers',
        name: 'AI Careers',
        description: 'jobs, hiring, career, salary',
      },
    ])
    .run();
});

describe('parseClassification — the model does not get to invent', () => {
  it('accepts a well-formed classification', () => {
    const parsed = parseClassification(
      { pillar: 'ai-news', relevance: 0.8, language: 'EN', reason: 'a launch' },
      SLUGS,
    );
    expect(parsed).toEqual({
      pillarSlug: 'ai-news',
      relevance: 0.8,
      language: 'EN',
      reason: 'a launch',
    });
  });

  it('rejects a pillar that does not exist', () => {
    // §7.1: an unrecognised pillar is a hallucination, not a discovery.
    expect(
      parseClassification({ pillar: 'ai-philosophy', relevance: 0.9 }, SLUGS),
    ).toBeNull();
  });

  it('rejects a relevance outside 0..1', () => {
    expect(parseClassification({ relevance: 1.5 }, SLUGS)).toBeNull();
    expect(parseClassification({ relevance: -0.1 }, SLUGS)).toBeNull();
  });

  it('rejects a non-numeric relevance', () => {
    expect(parseClassification({ relevance: 'high' }, SLUGS)).toBeNull();
    expect(parseClassification({ relevance: null }, SLUGS)).toBeNull();
  });

  it('rejects a language the system does not model', () => {
    expect(
      parseClassification({ relevance: 0.5, language: 'FR' }, SLUGS),
    ).toBeNull();
  });

  it('accepts an omitted pillar — "none fit" is a valid answer', () => {
    const parsed = parseClassification({ relevance: 0.2 }, SLUGS);
    expect(parsed?.pillarSlug).toBeNull();
  });

  it('normalises case on pillar and language', () => {
    const parsed = parseClassification(
      { pillar: 'AI-News', relevance: 0.5, language: 'en' },
      SLUGS,
    );
    expect(parsed?.pillarSlug).toBe('ai-news');
    expect(parsed?.language).toBe('EN');
  });

  it('rejects anything that is not an object', () => {
    expect(parseClassification(null, SLUGS)).toBeNull();
    expect(parseClassification('ai-news', SLUGS)).toBeNull();
    expect(parseClassification([1, 2], SLUGS)).toBeNull();
  });

  it('truncates an over-long reason rather than rejecting it', () => {
    const parsed = parseClassification(
      { relevance: 0.5, reason: 'x'.repeat(1000) },
      SLUGS,
    );
    expect(parsed?.reason.length).toBe(300);
  });
});

describe('classifyWithHeuristics', () => {
  it('attributes a launch story to the news pillar', () => {
    const result = classifyWithHeuristics(db, {
      title: 'OpenAI announces a model, now available',
      summary: 'The launch is available today.',
    });
    expect(result.pillarSlug).toBe('ai-news');
    expect(result.source).toBe('HEURISTIC');
    expect(result.relevance).toBeGreaterThan(0);
  });

  it('says nothing about language rather than guessing', () => {
    // Keyword matching cannot tell Hinglish from English, and null means
    // "not determined" rather than "English".
    expect(classifyWithHeuristics(db, { title: 'A launch' }).language).toBeNull();
  });

  it('explains itself', () => {
    const result = classifyWithHeuristics(db, {
      title: 'A new benchmark paper',
    });
    expect(result.reason).toContain('matched');
  });

  it('scores an unrelated story at zero', () => {
    const result = classifyWithHeuristics(db, {
      title: 'Local bakery wins award',
      summary: 'Cakes.',
    });
    expect(result.relevance).toBe(0);
  });

  it('names no pillar at all when nothing matched', () => {
    // §7.1: the pillar a heuristic could not determine is null. Not the
    // first pillar, not the most common one, not a plausible one.
    const result = classifyWithHeuristics(db, {
      title: 'Local bakery wins award',
      summary: 'Cakes.',
    });
    expect(result.pillarId).toBeNull();
    expect(result.pillarSlug).toBeNull();
  });

  it('resolves a matched pillar to a real id ingest can store', () => {
    const result = classifyWithHeuristics(db, {
      title: 'A new benchmark paper on arxiv',
    });
    const pillars = db.select().from(contentPillars).all();
    expect(result.pillarId).toBe(
      pillars.find((p) => p.slug === 'ai-research')?.id,
    );
  });
});

describe('classifyResearchItem — the local model when present', () => {
  it('uses the model’s answer', async () => {
    const result = await classifyResearchItem(
      db,
      { title: 'Something', summary: 'Something else' },
      stubProvider({
        pillar: 'ai-careers',
        relevance: 0.91,
        language: 'HINGLISH',
        reason: 'about AI hiring',
      }),
    );

    expect(result.source).toBe('LOCAL_MODEL');
    expect(result.pillarSlug).toBe('ai-careers');
    expect(result.relevance).toBe(0.91);
    expect(result.language).toBe('HINGLISH');
  });

  it('resolves the slug to a real pillar id', async () => {
    const result = await classifyResearchItem(
      db,
      { title: 'x' },
      stubProvider({ pillar: 'ai-research', relevance: 0.5 }),
    );

    const pillar = db.select().from(contentPillars).all();
    expect(result.pillarId).toBe(
      pillar.find((p) => p.slug === 'ai-research')?.id,
    );
  });

  it('leaves the pillar null when the model says none fit', async () => {
    // "None of these" is a valid answer and is stored as such. A model that
    // declines to place an item must not be second-guessed into one (§7.1).
    const result = await classifyResearchItem(
      db,
      { title: 'Local bakery wins award', summary: 'Cakes.' },
      stubProvider({ relevance: 0.05, reason: 'unrelated to AI' }),
    );

    expect(result.source).toBe('LOCAL_MODEL');
    expect(result.pillarId).toBeNull();
    expect(result.pillarSlug).toBeNull();
    expect(result.relevance).toBe(0.05);
  });

  it('records the run for cost and usage tracking (§43, §44)', async () => {
    await classifyResearchItem(
      db,
      { title: 'x' },
      stubProvider({ pillar: 'ai-news', relevance: 0.5 }),
    );

    const runs = db.select().from(agentRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe('qwen');
    expect(runs[0]?.status).toBe('OK');
    expect(runs[0]?.operation).toBe('classify-research');
  });
});

describe('classifyResearchItem — falling back', () => {
  it('falls back when no provider is configured', async () => {
    const result = await classifyResearchItem(
      db,
      { title: 'OpenAI announces a model, now available' },
      null,
    );
    expect(result.source).toBe('HEURISTIC');
    expect(result.pillarSlug).toBe('ai-news');
  });

  it('falls back when the daemon is not running', async () => {
    // The laptop may simply not have Ollama up. The queue must keep working.
    const result = await classifyResearchItem(
      db,
      { title: 'OpenAI announces a model, now available' },
      stubProvider({ pillar: 'ai-news', relevance: 0.9 }, { available: false }),
    );
    expect(result.source).toBe('HEURISTIC');
  });

  it('falls back when the model hallucinates a pillar', async () => {
    const result = await classifyResearchItem(
      db,
      { title: 'OpenAI announces a model, now available' },
      stubProvider({ pillar: 'invented-pillar', relevance: 0.9 }),
    );
    expect(result.source).toBe('HEURISTIC');
    expect(result.pillarSlug).toBe('ai-news');
  });

  it('falls back when the model returns nonsense', async () => {
    const result = await classifyResearchItem(
      db,
      { title: 'A benchmark paper' },
      stubProvider({ relevance: 'very high' }),
    );
    expect(result.source).toBe('HEURISTIC');
  });

  it('records the failed model attempt as well as the fallback', async () => {
    // A model that is quietly failing should show up in the data rather than
    // just silently degrading quality.
    await classifyResearchItem(
      db,
      { title: 'x' },
      stubProvider({ pillar: 'invented', relevance: 0.9 }),
    );

    const runs = db.select().from(agentRuns).all();
    expect(runs).toHaveLength(2);
    expect(runs.some((r) => r.agent === 'qwen' && r.status !== 'OK')).toBe(true);
    expect(runs.some((r) => r.agent === 'heuristic')).toBe(true);
  });

  it('records the heuristic run when there is no provider at all', async () => {
    await classifyResearchItem(db, { title: 'x' }, null);
    const runs = db.select().from(agentRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe('heuristic');
  });

  it('never throws, whatever the provider does', async () => {
    const exploding: StructuredProvider = {
      name: 'boom',
      model: null,
      available: async () => true,
      run: async () => {
        throw new Error('the model crashed');
      },
    };

    await expect(
      classifyResearchItem(db, { title: 'x' }, exploding),
    ).rejects.toThrow();
  });
});

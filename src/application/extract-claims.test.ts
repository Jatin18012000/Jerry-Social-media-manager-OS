import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { agentRuns, claims, researchItems, sources } from '@/db/schema';
import type { StructuredProvider } from '@/ports';
import {
  extractWithHeuristics,
  parseModelClaims,
  proposeAndStoreClaims,
  proposeClaims,
} from './extract-claims';

let sqlite: Database.Database;
let db: DB;

const SOURCE = [
  'OpenAI released a new reasoning model for developers today.',
  'The model was trained on approximately 15 trillion tokens.',
  'The company will expand availability to enterprise customers next year.',
].join(' ');

/** A provider returning whatever the test dictates. */
function stubProvider(
  output: unknown,
  opts: { available?: boolean } = {},
): StructuredProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    available: async () => opts.available ?? true,
    run: async (task) => {
      const parsed = task.parse(output);
      return {
        output: parsed,
        provider: 'stub',
        model: 'stub-model',
        durationMs: 3,
        status: parsed === null ? 'INVALID_OUTPUT' : 'OK',
      };
    },
  };
}

function seedResearchItem(): number {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'OpenAI Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  return db
    .insert(researchItems)
    .values({
      sourceId,
      title: 'A release',
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('parseModelClaims — the model does not get to invent a shape', () => {
  it('accepts a well-formed response', () => {
    const parsed = parseModelClaims({
      claims: [
        { text: 'OpenAI released a new reasoning model.', type: 'FACT' },
        { text: 'The company will expand availability.', type: 'PREDICTION' },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed?.[1]?.claimType).toBe('PREDICTION');
  });

  it('accepts an empty array — "no checkable claims" is a real answer', () => {
    expect(parseModelClaims({ claims: [] })).toEqual([]);
  });

  it('rejects a seventh claim type', () => {
    // §7.3 has exactly six categories and the model does not get a new one.
    expect(
      parseModelClaims({ claims: [{ text: 'A long enough claim.', type: 'RUMOUR' }] }),
    ).toBeNull();
  });

  it('rejects a missing type', () => {
    expect(
      parseModelClaims({ claims: [{ text: 'A long enough claim.' }] }),
    ).toBeNull();
  });

  it('rejects a claim too short to be one', () => {
    expect(parseModelClaims({ claims: [{ text: 'Yes.', type: 'FACT' }] })).toBeNull();
  });

  it('rejects a response with no claims array', () => {
    expect(parseModelClaims({ result: 'ok' })).toBeNull();
    expect(parseModelClaims({ claims: 'none' })).toBeNull();
  });

  it('rejects anything that is not an object', () => {
    expect(parseModelClaims(null)).toBeNull();
    expect(parseModelClaims([1, 2])).toBeNull();
  });

  it('normalises case on the type', () => {
    const parsed = parseModelClaims({
      claims: [{ text: 'A long enough claim here.', type: 'fact' }],
    });
    expect(parsed?.[0]?.claimType).toBe('FACT');
  });
});

describe('proposeClaims — the local model path', () => {
  it('uses verbatim model claims and marks them so', async () => {
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
          {
            text: 'The company will expand availability to enterprise customers next year.',
            type: 'PREDICTION',
          },
        ],
      }),
    );

    expect(outcome.source).toBe('LOCAL_MODEL');
    expect(outcome.claims).toHaveLength(2);
    expect(outcome.claims[0]?.grounding).toBe('VERBATIM');
    expect(outcome.claims[1]?.claimType).toBe('PREDICTION');
    expect(outcome.ungrounded).toHaveLength(0);
  });

  it('records the run', async () => {
    await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
        ],
      }),
    );

    const runs = db.select().from(agentRuns).all();
    expect(runs[0]?.agent).toBe('qwen');
    expect(runs[0]?.operation).toBe('extract-claims');
    expect(runs[0]?.status).toBe('OK');
  });
});

describe('proposeClaims — PRD §7.1, a claim not in the source is dropped', () => {
  it('drops an invented claim and keeps the real ones', async () => {
    // The whole reason the model path is acceptable. An invented claim would
    // be stored against a PRIMARY source and handed to a writer wearing its
    // authority — §57's Risk 2 exactly.
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
          {
            text: 'The model outperforms every competing system on all benchmarks.',
            type: 'FACT',
          },
        ],
      }),
    );

    expect(outcome.claims).toHaveLength(1);
    expect(outcome.ungrounded).toHaveLength(1);
    expect(outcome.ungrounded[0]?.text).toContain('outperforms');
  });

  it('drops a claim whose number was altered', async () => {
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'The model was trained on approximately 50 trillion tokens.',
            type: 'ESTIMATE',
          },
        ],
      }),
    );

    // The altered claim is gone. Heuristics then supply their own, which is
    // why the list is not empty.
    expect(outcome.source).toBe('HEURISTIC');
    expect(outcome.claims.some((c) => c.text.includes('50 trillion'))).toBe(
      false,
    );
    expect(outcome.claims.some((c) => c.text.includes('15 trillion'))).toBe(
      true,
    );
  });

  it('falls back when every claim is ungrounded', async () => {
    // Returning an empty list would read as "this text makes no claims",
    // which is a different and false statement.
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          { text: 'Something entirely fabricated about Google.', type: 'FACT' },
        ],
      }),
    );

    expect(outcome.source).toBe('HEURISTIC');
    expect(outcome.claims.length).toBeGreaterThan(0);
  });

  it('records ungrounded output as a distinct status', async () => {
    await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          { text: 'Something entirely fabricated about Google.', type: 'FACT' },
        ],
      }),
    );

    const runs = db.select().from(agentRuns).all();
    const modelRun = runs.find((r) => r.agent === 'qwen');
    expect(modelRun?.status).toBe('UNGROUNDED');
    expect(modelRun?.error).toContain('not found in source');
  });

  it('deduplicates repeated model claims', async () => {
    const text = 'OpenAI released a new reasoning model for developers today.';
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({
        claims: [
          { text, type: 'FACT' },
          { text, type: 'FACT' },
        ],
      }),
    );
    expect(outcome.claims).toHaveLength(1);
  });
});

describe('proposeClaims — falling back', () => {
  it('uses heuristics with no provider', async () => {
    const outcome = await proposeClaims(db, SOURCE, null);
    expect(outcome.source).toBe('HEURISTIC');
    expect(outcome.claims.length).toBeGreaterThan(0);
  });

  it('uses heuristics when the daemon is not running', async () => {
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({ claims: [] }, { available: false }),
    );
    expect(outcome.source).toBe('HEURISTIC');
  });

  it('uses heuristics when the model returns an unusable shape', async () => {
    const outcome = await proposeClaims(
      db,
      SOURCE,
      stubProvider({ claims: [{ text: 'x', type: 'NONSENSE' }] }),
    );
    expect(outcome.source).toBe('HEURISTIC');
  });

  it('records the heuristic run too', async () => {
    await proposeClaims(db, SOURCE, null);
    const runs = db.select().from(agentRuns).all();
    expect(runs[0]?.agent).toBe('heuristic');
  });

  it('returns nothing for empty text without calling anything', async () => {
    const outcome = await proposeClaims(db, '   ', null);
    expect(outcome.claims).toEqual([]);
    expect(db.select().from(agentRuns).all()).toHaveLength(0);
  });
});

describe('extractWithHeuristics', () => {
  it('cannot invent anything — it returns sentences it was given', () => {
    const outcome = extractWithHeuristics(SOURCE);
    for (const claim of outcome.claims) {
      expect(SOURCE).toContain(claim.text);
    }
  });
});

describe('proposeAndStoreClaims', () => {
  it('stores every claim as UNVERIFIED', async () => {
    const researchItemId = seedResearchItem();
    await proposeAndStoreClaims(
      db,
      researchItemId,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
        ],
      }),
    );

    const stored = db.select().from(claims).all();
    expect(stored).toHaveLength(1);
    // §7.1: no path here can verify anything.
    expect(stored[0]?.verificationStatus).toBe('UNVERIFIED');
    expect(stored[0]?.evidenceUrl).toBeNull();
    expect(stored[0]?.evidenceTier).toBeNull();
  });

  it('records which path proposed it, so a reviewer can see', async () => {
    const researchItemId = seedResearchItem();
    await proposeAndStoreClaims(
      db,
      researchItemId,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
        ],
      }),
    );

    expect(db.select().from(claims).all()[0]?.note).toContain('local model');
  });

  it('says heuristic when that is what ran', async () => {
    const researchItemId = seedResearchItem();
    await proposeAndStoreClaims(db, researchItemId, SOURCE, null);
    expect(db.select().from(claims).all()[0]?.note).toContain('heuristic');
  });

  it('never stores an ungrounded claim', async () => {
    const researchItemId = seedResearchItem();
    await proposeAndStoreClaims(
      db,
      researchItemId,
      SOURCE,
      stubProvider({
        claims: [
          {
            text: 'OpenAI released a new reasoning model for developers today.',
            type: 'FACT',
          },
          { text: 'The model has one billion paying users.', type: 'FACT' },
        ],
      }),
    );

    const stored = db.select().from(claims).all();
    expect(stored.some((c) => c.text.includes('billion paying'))).toBe(false);
  });

  it('throws on an unknown research item', async () => {
    await expect(
      proposeAndStoreClaims(db, 9999, SOURCE, null),
    ).rejects.toThrow(/No research item/);
  });
});

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  claims,
  contentPillars,
  notifications,
  researchItems,
  sources,
  systemEvents,
} from '@/db/schema';
import type { FetchedItem, SourceFetcher } from '@/ports';
import {
  dueSources,
  ingestDueSources,
  ingestManualUrl,
  ingestSource,
  triageQueue,
} from './ingest';

let sqlite: Database.Database;
let db: DB;

/** A fetcher returning fixed items, so no test touches the network. */
function stubFetcher(
  items: FetchedItem[],
  kind: SourceFetcher['kind'] = 'RSS',
): SourceFetcher {
  return { name: 'stub', kind, fetch: async () => items };
}

function failingFetcher(message: string): SourceFetcher {
  return {
    name: 'failing',
    kind: 'RSS',
    fetch: async () => {
      throw new Error(message);
    },
  };
}

function seedSource(name = 'Example Blog'): number {
  return db
    .insert(sources)
    .values({
      name,
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${name.replace(/\s+/g, '-')}`,
      feedUrl: 'https://example.com/feed.xml',
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;
}

function seedPillars(): void {
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
    ])
    .run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
  seedPillars();
});

describe('ingestSource', () => {
  it('stores fetched items with provenance and a relevance score', async () => {
    const sourceId = seedSource();
    const report = await ingestSource(
      db,
      sourceId,
      () =>
        stubFetcher([
          {
            title: 'OpenAI released a new model',
            url: 'https://example.com/a',
            summary: 'OpenAI released a new reasoning model for developers.',
            publishedAt: new Date('2026-09-20T10:00:00Z'),
          },
        ]),
    );

    expect(report.fetched).toBe(1);
    expect(report.stored).toBe(1);
    expect(report.failed).toBe(0);

    const row = db.select().from(researchItems).all()[0];
    expect(row?.sourceId).toBe(sourceId);
    expect(row?.relevanceScore).toBeGreaterThan(0);
    expect(row?.status).toBe('NEW');
  });

  it('canonicalises the stored URL', async () => {
    const sourceId = seedSource();
    await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'A post',
          url: 'https://WWW.Example.com/post?utm_source=rss#top',
        },
      ]),
    );
    expect(db.select().from(researchItems).all()[0]?.url).toBe(
      'https://example.com/post',
    );
  });

  it('proposes claim candidates, all of them unverified', async () => {
    const sourceId = seedSource();
    const report = await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'Model release',
          url: 'https://example.com/claims',
          summary:
            'OpenAI released a new reasoning model today for developers. ' +
            'The company will expand availability next year.',
        },
      ]),
    );

    expect(report.claimsProposed).toBeGreaterThan(0);

    const stored = db.select().from(claims).all();
    // §7.1: ingestion has no verification capability and must never imply one.
    for (const claim of stored) {
      expect(claim.verificationStatus).toBe('UNVERIFIED');
      expect(claim.evidenceUrl).toBeNull();
    }
    expect(stored.some((c) => c.claimType === 'FACT')).toBe(true);
    expect(stored.some((c) => c.claimType === 'PREDICTION')).toBe(true);
  });

  it('skips an item it already holds, by canonical URL', async () => {
    const sourceId = seedSource();
    const item: FetchedItem = {
      title: 'A post',
      url: 'https://example.com/same',
    };

    await ingestSource(db, sourceId, () => stubFetcher([item]));
    const second = await ingestSource(db, sourceId, () =>
      stubFetcher([{ ...item, url: 'https://www.example.com/same?ref=x' }]),
    );

    expect(second.stored).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(db.select().from(researchItems).all()).toHaveLength(1);
  });

  it('records a cross-source duplicate rather than discarding it', async () => {
    const primary = seedSource('Primary');
    const secondary = seedSource('Secondary');

    await ingestSource(db, primary, () =>
      stubFetcher([
        {
          title: 'OpenAI announces GPT-5',
          url: 'https://openai.com/gpt-5',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );

    const report = await ingestSource(db, secondary, () =>
      stubFetcher([
        {
          title: 'GPT-5 announced by OpenAI',
          url: 'https://techcrunch.com/gpt-5',
          publishedAt: new Date('2026-09-20T13:00:00Z'),
        },
      ]),
    );

    expect(report.duplicates).toBe(1);

    // §7.4: kept and linked, not dropped — a discarded item is invisible.
    const rows = db.select().from(researchItems).all();
    expect(rows).toHaveLength(2);
    const dupe = rows.find((r) => r.status === 'DUPLICATE');
    expect(dupe).toBeDefined();
    expect(dupe?.duplicateOfId).toBe(rows[0]?.id);
  });

  it('catches a duplicate appearing twice within one batch', async () => {
    const sourceId = seedSource();
    const report = await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'OpenAI announces GPT-5',
          url: 'https://example.com/one',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
        {
          title: 'GPT-5 announced by OpenAI',
          url: 'https://example.com/two',
          publishedAt: new Date('2026-09-20T11:00:00Z'),
        },
      ]),
    );
    expect(report.stored).toBe(1);
    expect(report.duplicates).toBe(1);
  });

  it('does not propose claims for a duplicate', async () => {
    const a = seedSource('A');
    const b = seedSource('B');
    const summary = 'OpenAI released a new model for developers today.';

    await ingestSource(db, a, () =>
      stubFetcher([
        {
          title: 'OpenAI announces GPT-5',
          url: 'https://a.example/1',
          summary,
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );
    const before = db.select().from(claims).all().length;

    await ingestSource(db, b, () =>
      stubFetcher([
        {
          title: 'GPT-5 announced by OpenAI',
          url: 'https://b.example/1',
          summary,
          publishedAt: new Date('2026-09-20T11:00:00Z'),
        },
      ]),
    );
    expect(db.select().from(claims).all().length).toBe(before);
  });

  it('records a fetch failure against the source and does not throw', async () => {
    const sourceId = seedSource();
    const report = await ingestSource(db, sourceId, () =>
      failingFetcher('connection reset'),
    );

    expect(report.failed).toBe(1);
    expect(report.errors[0]).toContain('connection reset');

    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get();
    expect(row?.lastError).toContain('connection reset');
    // Polled-at still advances, so one broken source cannot spin the loop.
    expect(row?.lastPolledAt).not.toBeNull();

    const events = db.select().from(systemEvents).all();
    expect(events.some((e) => e.kind === 'source.fetch_failed')).toBe(true);
  });

  it('clears a previous error after a successful poll', async () => {
    const sourceId = seedSource();
    await ingestSource(db, sourceId, () => failingFetcher('boom'));
    await ingestSource(db, sourceId, () =>
      stubFetcher([{ title: 'Recovered', url: 'https://example.com/ok' }]),
    );
    expect(
      db.select().from(sources).where(eq(sources.id, sourceId)).get()?.lastError,
    ).toBeNull();
  });

  it('counts a bad item as failed but still stores the good ones', async () => {
    const sourceId = seedSource();
    const report = await ingestSource(db, sourceId, () =>
      stubFetcher([
        { title: 'No URL here', url: '' },
        { title: 'Fine', url: 'https://example.com/fine' },
      ]),
    );
    expect(report.failed).toBe(1);
    expect(report.stored).toBe(1);
  });

  it('writes an audit event for the run', async () => {
    const sourceId = seedSource();
    await ingestSource(db, sourceId, () =>
      stubFetcher([{ title: 'X', url: 'https://example.com/x' }]),
    );
    const events = db.select().from(systemEvents).all();
    expect(events.some((e) => e.kind === 'source.ingested')).toBe(true);
  });

  it('throws on an unknown source id', async () => {
    await expect(
      ingestSource(db, 9999, () => stubFetcher([])),
    ).rejects.toThrow(/Unknown source/);
  });
});

describe('ingestion persists the pillar the classifier determined', () => {
  it('stores the primary pillar when one was determined', async () => {
    const sourceId = seedSource();

    await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'OpenAI released a new model',
          url: 'https://example.com/pillar-a',
          summary: 'OpenAI announces a new model, available today.',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );

    const row = db.select().from(researchItems).all()[0];
    const pillar = db
      .select()
      .from(contentPillars)
      .all()
      .find((p) => p.id === row?.primaryPillarId);

    // The classifier's answer is no longer discarded at ingestion.
    expect(row?.primaryPillarId).not.toBeNull();
    expect(pillar?.slug).toBe('ai-news');
  });

  it('stores NULL when no pillar could be determined', async () => {
    // UNCLASSIFIED is an outcome, not a gap. Forcing the nearest pillar
    // would be inventing a classification (§7.1).
    const sourceId = seedSource();

    await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'Quarterly gardening almanac',
          url: 'https://example.com/pillar-b',
          summary: 'Nothing to do with any of the four pillars.',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );

    expect(db.select().from(researchItems).all()[0]?.primaryPillarId).toBeNull();
  });

  it('stores NULL when no pillars are configured at all', async () => {
    db.delete(contentPillars).run();
    const sourceId = seedSource();

    await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'OpenAI released a new model',
          url: 'https://example.com/pillar-c',
          summary: 'OpenAI announces a new model.',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );

    expect(db.select().from(researchItems).all()[0]?.primaryPillarId).toBeNull();
  });
});

describe('dueSources', () => {
  it('includes a source that has never been polled', () => {
    const id = seedSource();
    expect(dueSources(db)).toContain(id);
  });

  it('excludes a source polled inside its interval', async () => {
    const id = seedSource();
    const now = new Date('2026-09-21T12:00:00Z');
    await ingestSource(db, id, () => stubFetcher([]), { now });

    const soon = new Date('2026-09-21T12:30:00Z'); // interval defaults to 60m
    expect(dueSources(db, soon)).not.toContain(id);
  });

  it('includes a source once its interval has elapsed', async () => {
    const id = seedSource();
    const now = new Date('2026-09-21T12:00:00Z');
    await ingestSource(db, id, () => stubFetcher([]), { now });

    const later = new Date('2026-09-21T13:30:00Z');
    expect(dueSources(db, later)).toContain(id);
  });

  it('excludes a disabled source', () => {
    const id = seedSource();
    db.update(sources).set({ enabled: false }).where(eq(sources.id, id)).run();
    expect(dueSources(db)).not.toContain(id);
  });
});

describe('ingestDueSources', () => {
  it('reports on each due source', async () => {
    seedSource('One');
    seedSource('Two');
    const reports = await ingestDueSources(db, () =>
      stubFetcher([{ title: 'T', url: 'https://example.com/t' }]),
    );
    expect(reports).toHaveLength(2);
  });

  it('continues past a source that fails', async () => {
    const bad = seedSource('Bad');
    seedSource('Good');

    const reports = await ingestDueSources(db, (kind) =>
      kind === 'RSS'
        ? stubFetcher([{ title: 'T', url: `https://example.com/${Date.now()}` }])
        : stubFetcher([]),
    );
    expect(reports).toHaveLength(2);
    expect(bad).toBeGreaterThan(0);
  });
});

describe('ingestManualUrl', () => {
  it('creates a standing manual source and stores the item', async () => {
    const report = await ingestManualUrl(
      db,
      'https://example.com/pasted',
      stubFetcher(
        [
          {
            title: 'Something spotted on X',
            url: 'https://example.com/pasted',
            summary: 'A company announced a new model today for everyone.',
          },
        ],
        'MANUAL',
      ),
    );

    expect(report.stored).toBe(1);

    const manual = db
      .select()
      .from(sources)
      .where(eq(sources.fetcher, 'MANUAL'))
      .get();
    expect(manual).toBeDefined();
    // §7.2: pasting a link confers no authority on it.
    expect(manual?.credibilityTier).toBe('OTHER');
  });

  it('reuses the manual source on a second paste', async () => {
    const fetcherFor = (url: string) =>
      stubFetcher([{ title: 'T', url }], 'MANUAL');

    await ingestManualUrl(db, 'https://example.com/1', fetcherFor('https://example.com/1'));
    await ingestManualUrl(db, 'https://example.com/2', fetcherFor('https://example.com/2'));

    const manualSources = db
      .select()
      .from(sources)
      .where(eq(sources.fetcher, 'MANUAL'))
      .all();
    expect(manualSources).toHaveLength(1);
    expect(db.select().from(researchItems).all()).toHaveLength(2);
  });
});

describe('triageQueue', () => {
  it('orders by relevance, most relevant first', async () => {
    const sourceId = seedSource();
    await ingestSource(db, sourceId, () =>
      stubFetcher([
        {
          title: 'Local bakery news',
          url: 'https://example.com/bakery',
          summary: 'Cakes and pastries.',
        },
        {
          title: 'OpenAI released a new model, now available',
          url: 'https://example.com/model',
          summary: 'The AI model launch is available to developers.',
        },
      ]),
    );

    const queue = triageQueue(db);
    expect(queue[0]?.title).toContain('OpenAI');
  });

  it('excludes items already marked duplicate', async () => {
    const a = seedSource('A');
    const b = seedSource('B');
    await ingestSource(db, a, () =>
      stubFetcher([
        {
          title: 'OpenAI announces GPT-5',
          url: 'https://a.example/x',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]),
    );
    await ingestSource(db, b, () =>
      stubFetcher([
        {
          title: 'GPT-5 announced by OpenAI',
          url: 'https://b.example/x',
          publishedAt: new Date('2026-09-20T11:00:00Z'),
        },
      ]),
    );

    expect(triageQueue(db)).toHaveLength(1);
  });
});

describe('notifications — PRD §47', () => {
  it('announces a source that has stopped responding', async () => {
    const sourceId = seedSource('OpenAI Blog');
    await ingestSource(db, sourceId, () => failingFetcher('connection reset'));

    const failure = db
      .select()
      .from(notifications)
      .all()
      .find((n) => n.kind === 'SYSTEM_FAILURE');

    expect(failure).toBeDefined();
    expect(failure?.title).toContain('OpenAI Blog');
    expect(failure?.severity).toBe('ERROR');
  });

  it('does not pile up a notification per failed poll', async () => {
    // A source failing for a week should be one unread item, not 168.
    const sourceId = seedSource();
    for (let i = 0; i < 10; i += 1) {
      await ingestSource(db, sourceId, () => failingFetcher('still down'));
    }

    expect(db.select().from(notifications).all()).toHaveLength(1);
  });

  it('keeps separate failing sources separate', async () => {
    const a = seedSource('Source A');
    const b = seedSource('Source B');
    await ingestSource(db, a, () => failingFetcher('down'));
    await ingestSource(db, b, () => failingFetcher('down'));

    expect(db.select().from(notifications).all()).toHaveLength(2);
  });

  it('says nothing when a source is working', async () => {
    const sourceId = seedSource();
    await ingestSource(db, sourceId, () =>
      stubFetcher([{ title: 'Fine', url: 'https://example.com/ok' }]),
    );
    expect(db.select().from(notifications).all()).toHaveLength(0);
  });
});

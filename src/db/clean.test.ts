import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from './client';
import { clean } from './clean';
import * as schema from './schema';
import {
  brandConfig,
  claims,
  contentItems,
  contentOpportunities,
  contentPillars,
  researchItems,
  sources,
} from './schema';
import { SEED_SOURCE_URLS, seed } from './seed';

let dir: string;
let url: string;
let db: DB;
let sqlite: Database.Database;

function open(): DB {
  sqlite = new Database(url);
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema }) as unknown as DB;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'smos-clean-'));
  url = join(dir, 'test.db');

  db = open();
  migrate(db as never, { migrationsFolder: './drizzle' });
  sqlite.close();

  // A seeded database, as a real one starts.
  seed(url);
  db = open();
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

/** A demo-shaped research item on an invented source. */
function demoRow(): { sourceId: number; researchItemId: number } {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  const researchItemId = db
    .insert(researchItems)
    .values({
      sourceId,
      title: 'A demo item',
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;

  db.insert(claims)
    .values({ researchItemId, text: 'A thing happened.', claimType: 'FACT' })
    .run();

  return { sourceId, researchItemId };
}

describe('clean — what it removes', () => {
  it('removes demo research, claims and the sources they invented', () => {
    demoRow();
    demoRow();
    sqlite.close();

    const report = clean(url);
    db = open();

    expect(db.select().from(researchItems).all()).toHaveLength(0);
    expect(db.select().from(claims).all()).toHaveLength(0);
    expect(report.deleted['research_items']).toBe(2);
  });

  it('removes opportunities and content items', () => {
    const { researchItemId } = demoRow();
    const opportunityId = db
      .insert(contentOpportunities)
      .values({ title: 'An opportunity' })
      .returning({ id: contentOpportunities.id })
      .get().id;
    db.insert(schema.opportunityResearch)
      .values({ opportunityId, researchItemId })
      .run();
    db.insert(contentItems)
      .values({ opportunityId, platform: 'INSTAGRAM', format: 'REEL' })
      .run();
    sqlite.close();

    clean(url);
    db = open();

    expect(db.select().from(contentItems).all()).toHaveLength(0);
    expect(db.select().from(contentOpportunities).all()).toHaveLength(0);
  });

  it('reports nothing to remove on an untouched database', () => {
    sqlite.close();
    const report = clean(url);
    db = open();

    expect(report.total).toBe(0);
  });

  it('is safe to run twice', () => {
    demoRow();
    sqlite.close();

    clean(url);
    const second = clean(url);
    db = open();

    expect(second.total).toBe(0);
  });
});

describe('clean — what it keeps', () => {
  it('keeps the §10 pillars', () => {
    // Seeded, but editable — re-seeding deliberately does not clobber an
    // edited name, and neither may this.
    const before = db.select().from(contentPillars).all().length;
    expect(before).toBeGreaterThan(0);
    demoRow();
    sqlite.close();

    const report = clean(url);
    db = open();

    expect(db.select().from(contentPillars).all()).toHaveLength(before);
    expect(report.pillarsKept).toBe(before);
  });

  it('keeps every seeded §14 source and removes only the invented ones', () => {
    const seeded = db.select().from(sources).all().length;
    demoRow();
    demoRow();
    demoRow();
    sqlite.close();

    const report = clean(url);
    db = open();

    const remaining = db.select().from(sources).all();
    expect(remaining).toHaveLength(seeded);
    expect(report.deleted['sources']).toBe(3);
    // Every survivor is a seeded URL, not a demo one.
    for (const source of remaining) {
      expect(SEED_SOURCE_URLS).toContain(source.url);
    }
  });

  it('identifies sources by URL, not by row id', () => {
    // Ids shift the moment anything is inserted or deleted. A cleanup that
    // deleted the wrong row because an id moved would be worse than none.
    const openai = db
      .select()
      .from(sources)
      .where(eq(sources.url, 'https://openai.com/news/'))
      .get();
    expect(openai).toBeDefined();

    demoRow();
    // Delete a seeded source so the surrounding ids no longer line up.
    db.delete(sources)
      .where(eq(sources.url, 'https://www.theverge.com/ai-artificial-intelligence'))
      .run();
    sqlite.close();

    clean(url);
    db = open();

    expect(
      db.select().from(sources).where(eq(sources.url, 'https://openai.com/news/')).get(),
    ).toBeDefined();
  });

  it('keeps the manual-URL bucket, which is infrastructure not demo data', () => {
    db.insert(sources)
      .values({
        name: 'Manual additions',
        type: 'MANUAL',
        fetcher: 'MANUAL',
        url: 'about:manual',
        credibilityTier: 'CREDIBLE_SECONDARY',
      })
      .run();
    sqlite.close();

    clean(url);
    db = open();

    expect(
      db.select().from(sources).where(eq(sources.url, 'about:manual')).get(),
    ).toBeDefined();
  });
});

describe('clean — the brand configuration', () => {
  function setBrand(isPlaceholder: boolean, name = 'Some Brand') {
    db.insert(brandConfig)
      .values({
        version: 1,
        active: true,
        payloadJson: JSON.stringify({ brandName: name, isPlaceholder }),
      })
      .run();
  }

  it('keeps it by default and names it, so a fabricated one is visible', () => {
    // §4 puts brand voice with Jatin and ChatGPT. Losing a real one to a
    // cleanup script would destroy work this repository cannot regenerate.
    setBrand(false, 'Jatin — AI & Technology');
    sqlite.close();

    const report = clean(url);
    db = open();

    expect(db.select().from(brandConfig).all()).toHaveLength(1);
    expect(report.brandConfigKept).toBe('Jatin — AI & Technology');
    expect(report.brandConfigDeleted).toBe(false);
  });

  it('does not nag about a placeholder, which is meant to be there', () => {
    setBrand(true);
    sqlite.close();

    const report = clean(url);
    db = open();

    expect(report.brandConfigKept).toBeNull();
  });

  it('removes it only when explicitly asked', () => {
    setBrand(false);
    sqlite.close();

    const report = clean(url, { brand: true });
    db = open();

    expect(db.select().from(brandConfig).all()).toHaveLength(0);
    expect(report.brandConfigDeleted).toBe(true);
  });

  it('reports an unreadable payload rather than staying silent', () => {
    db.insert(brandConfig)
      .values({ version: 1, active: true, payloadJson: 'not json' })
      .run();
    sqlite.close();

    const report = clean(url);
    db = open();

    expect(report.brandConfigKept).toBe('unreadable');
  });
});

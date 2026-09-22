import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/**
 * Migration safety.
 *
 * The P0 pillar work required an additive migration that leaves existing
 * research rows valid. "Additive" is easy to claim and easy to get wrong, so
 * it is asserted here against real SQL rather than argued for in a comment:
 * migrations are applied in order to a database that already holds data, and
 * that data is checked afterwards.
 */

const DIR = join(process.cwd(), 'drizzle');

function migrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function applyThrough(db: Database.Database, lastFile: string): void {
  for (const file of migrations()) {
    db.exec(readFileSync(join(DIR, file), 'utf8').replace(/--> statement-breakpoint/g, ''));
    if (file === lastFile) return;
  }
}

function apply(db: Database.Database, file: string): void {
  db.exec(readFileSync(join(DIR, file), 'utf8').replace(/--> statement-breakpoint/g, ''));
}

/** The migration that introduced research pillars. */
const PILLAR_MIGRATION = '0004_colorful_pretty_boy.sql';
/** The one before it, i.e. the state a live database would be in. */
const BEFORE_PILLARS = '0003_nosy_king_cobra.sql';

describe('H — existing research rows survive the pillar migration', () => {
  function seededDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyThrough(db, BEFORE_PILLARS);

    db.prepare(
      `insert into sources (name, type, fetcher, url, credibility_tier)
       values ('OpenAI Blog', 'OFFICIAL_BLOG', 'RSS', 'https://openai.com/news/', 'PRIMARY')`,
    ).run();

    db.prepare(
      `insert into research_items (source_id, title, url, dedupe_key, relevance_score)
       values (1, 'A pre-existing item', 'https://example.com/a', 'k-a', 0.8)`,
    ).run();

    db.prepare(
      `insert into claims (research_item_id, text, claim_type)
       values (1, 'A thing happened.', 'FACT')`,
    ).run();

    return db;
  }

  it('leaves the row present and readable', () => {
    const db = seededDb();
    apply(db, PILLAR_MIGRATION);

    const row = db
      .prepare('select id, title, relevance_score, primary_pillar_id from research_items')
      .get() as { id: number; title: string; relevance_score: number; primary_pillar_id: number | null };

    expect(row.id).toBe(1);
    expect(row.title).toBe('A pre-existing item');
    // Existing columns keep their values.
    expect(row.relevance_score).toBe(0.8);
    db.close();
  });

  it('leaves it UNCLASSIFIED rather than back-dating a pillar', () => {
    // No retroactive classification: the item was ingested before the
    // classifier's answer was retained, and inventing one now would be
    // exactly the §7.1 failure the NULL exists to avoid.
    const db = seededDb();
    apply(db, PILLAR_MIGRATION);

    const row = db
      .prepare('select primary_pillar_id from research_items')
      .get() as { primary_pillar_id: number | null };

    expect(row.primary_pillar_id).toBeNull();
    db.close();
  });

  it('preserves provenance — claims still attach to the item', () => {
    const db = seededDb();
    apply(db, PILLAR_MIGRATION);

    const claims = db
      .prepare('select research_item_id, text from claims')
      .all() as { research_item_id: number; text: string }[];

    expect(claims).toHaveLength(1);
    expect(claims[0]?.research_item_id).toBe(1);
    db.close();
  });

  it('adds the secondary-pillar table empty', () => {
    const db = seededDb();
    apply(db, PILLAR_MIGRATION);

    const count = db
      .prepare('select count(*) as c from research_item_pillars')
      .get() as { c: number };

    expect(count.c).toBe(0);
    db.close();
  });

  it('is additive — it drops nothing and rebuilds no table', () => {
    // A table rebuild would be a destructive migration wearing a safe name.
    const sql = readFileSync(join(DIR, PILLAR_MIGRATION), 'utf8').toLowerCase();

    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('__old');
    expect(sql).not.toContain('rename to');
  });

  it('applies cleanly to an empty database too', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => {
      for (const file of migrations()) apply(db, file);
    }).not.toThrow();
    db.close();
  });
});

describe('the brand-config migration is additive too', () => {
  it('drops nothing and rebuilds no table', () => {
    const sql = readFileSync(
      join(DIR, '0003_nosy_king_cobra.sql'),
      'utf8',
    ).toLowerCase();

    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('rename to');
  });

  it('leaves an existing brand row valid and marked placeholder', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyThrough(db, '0002_pink_captain_cross.sql');

    db.prepare(
      `insert into brand_config (version, active, payload_json)
       values (1, 0, '{"brandName":"x"}')`,
    ).run();

    apply(db, '0003_nosy_king_cobra.sql');

    const row = db
      .prepare('select version, is_placeholder, activated_by from brand_config')
      .get() as { version: number; is_placeholder: number; activated_by: string | null };

    expect(row.version).toBe(1);
    // Defaults to placeholder: a pre-existing row has no recorded human
    // behind it, and treating it as a real brand voice would assume one.
    expect(row.is_placeholder).toBe(1);
    expect(row.activated_by).toBeNull();
    db.close();
  });
});

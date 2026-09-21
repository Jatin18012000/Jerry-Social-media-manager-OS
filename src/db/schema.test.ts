import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Integration tests against a real migrated SQLite database.
 *
 * The point of these is not to test Drizzle. It is to prove that the
 * database-level guarantees actually exist in the generated schema — because
 * the domain layer's guards and the application's care are both bypassable by
 * a bug, and these are not.
 */

type Db = ReturnType<typeof drizzle>;

let sqlite: Database.Database;
let db: Db;

function migrated(): { sqlite: Database.Database; db: Db } {
  const s = new Database(':memory:');
  s.pragma('foreign_keys = ON');
  const d = drizzle(s);
  migrate(d, { migrationsFolder: './drizzle' });
  return { sqlite: s, db: d };
}

/** Minimal fixture: one source, one research item, one content item. */
function seed(s: Database.Database): {
  sourceId: number;
  researchItemId: number;
  contentItemId: number;
} {
  const sourceId = Number(
    s
      .prepare(
        `INSERT INTO sources (name, type, fetcher, url, credibility_tier)
         VALUES ('OpenAI Blog', 'OFFICIAL_BLOG', 'RSS', 'https://example.test/a', 'PRIMARY')`,
      )
      .run().lastInsertRowid,
  );

  const researchItemId = Number(
    s
      .prepare(
        `INSERT INTO research_items (source_id, title, url, dedupe_key)
         VALUES (?, 'Model Y released', 'https://example.test/post', 'model-y')`,
      )
      .run(sourceId).lastInsertRowid,
  );

  const contentItemId = Number(
    s
      .prepare(
        `INSERT INTO content_items (platform, format) VALUES ('INSTAGRAM', 'REEL')`,
      )
      .run().lastInsertRowid,
  );

  return { sourceId, researchItemId, contentItemId };
}

beforeEach(() => {
  const m = migrated();
  sqlite = m.sqlite;
  db = m.db;
  void db;
});

describe('migrations', () => {
  it('creates every table the PRD §37 entity list requires', () => {
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);

    for (const expected of [
      'sources',
      'research_items',
      'claims',
      'content_opportunities',
      'content_items',
      'content_item_sources',
      'media_assets',
      'briefs',
      'generations',
      'approval_events',
      'schedule_jobs',
      'publication_records',
      'analytics_snapshots',
      'experiments',
      'content_experiments',
      'learning_findings',
      'agent_runs',
      'cost_records',
      'system_events',
      'brand_config',
      'prompt_templates',
      'content_pillars',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it('enforces foreign keys', () => {
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO research_items (source_id, title, url, dedupe_key)
           VALUES (9999, 't', 'https://example.test/x', 'k')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('PRD §39 — a content item cannot be published twice', () => {
  it('rejects a second publication record for the same item and platform', () => {
    const { contentItemId } = seed(sqlite);

    const insert = sqlite.prepare(
      `INSERT INTO publication_records
         (content_item_id, platform, publisher_kind, external_id, published_at)
       VALUES (?, 'INSTAGRAM', 'INSTAGRAM_API', ?, 1758441600000)`,
    );

    insert.run(contentItemId, 'ig_abc123');

    // A retried worker attempting the same publish must be stopped by the
    // database, not merely by application logic.
    expect(() => insert.run(contentItemId, 'ig_def456')).toThrow(/UNIQUE/i);
  });

  it('still allows the same item on a different platform', () => {
    const { contentItemId } = seed(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO publication_records
         (content_item_id, platform, publisher_kind, external_id, published_at)
       VALUES (?, ?, 'MANUAL', 'x', 1758441600000)`,
    );
    insert.run(contentItemId, 'INSTAGRAM');
    expect(() => insert.run(contentItemId, 'LINKEDIN')).not.toThrow();
  });

  it('rejects a duplicate schedule job idempotency key', () => {
    const { contentItemId } = seed(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO schedule_jobs (content_item_id, run_at, idempotency_key)
       VALUES (?, 1758441600000, 'job-key-1')`,
    );
    insert.run(contentItemId);
    expect(() => insert.run(contentItemId)).toThrow(/UNIQUE/i);
  });
});

describe('PRD §40 — a publication record must carry evidence', () => {
  it('rejects a record with neither an external ID nor a human confirmation', () => {
    const { contentItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO publication_records
             (content_item_id, platform, publisher_kind, published_at)
           VALUES (?, 'INSTAGRAM', 'MANUAL', 1758441600000)`,
        )
        .run(contentItemId),
    ).toThrow(/CHECK/i);
  });

  it('accepts an API publish evidenced by an external ID', () => {
    const { contentItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO publication_records
             (content_item_id, platform, publisher_kind, external_id, published_at)
           VALUES (?, 'INSTAGRAM', 'INSTAGRAM_API', 'ig_1', 1758441600000)`,
        )
        .run(contentItemId),
    ).not.toThrow();
  });

  it('accepts a manual publish evidenced by a human confirmation', () => {
    const { contentItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO publication_records
             (content_item_id, platform, publisher_kind, confirmed_by, published_at)
           VALUES (?, 'INSTAGRAM', 'MANUAL', 'jatin', 1758441600000)`,
        )
        .run(contentItemId),
    ).not.toThrow();
  });
});

describe('PRD §7.2 — a verified claim must say what verified it', () => {
  it('rejects a VERIFIED claim with no evidence url or tier', () => {
    const { researchItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO claims (research_item_id, text, claim_type, verification_status)
           VALUES (?, 'Company X released Model Y', 'FACT', 'VERIFIED')`,
        )
        .run(researchItemId),
    ).toThrow(/CHECK/i);
  });

  it('accepts a VERIFIED claim carrying its evidence', () => {
    const { researchItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO claims
             (research_item_id, text, claim_type, verification_status,
              evidence_url, evidence_tier)
           VALUES (?, 'Company X released Model Y', 'FACT', 'VERIFIED',
                   'https://official.example/announcement', 'PRIMARY')`,
        )
        .run(researchItemId),
    ).not.toThrow();
  });

  it('accepts an UNVERIFIED claim without evidence — that is the point', () => {
    const { researchItemId } = seed(sqlite);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO claims (research_item_id, text, claim_type)
           VALUES (?, 'This may ship next quarter', 'PREDICTION')`,
        )
        .run(researchItemId),
    ).not.toThrow();
  });
});

describe('PRD §26/§40 — unreported metrics are NULL, never zero', () => {
  it('stores an absent metric as NULL', () => {
    const { contentItemId } = seed(sqlite);
    sqlite
      .prepare(
        `INSERT INTO analytics_snapshots (content_item_id, source, impressions)
         VALUES (?, 'OCR', 1200)`,
      )
      .run(contentItemId);

    const row = sqlite
      .prepare(
        `SELECT impressions, saves, follows FROM analytics_snapshots WHERE content_item_id = ?`,
      )
      .get(contentItemId) as {
      impressions: number | null;
      saves: number | null;
      follows: number | null;
    };

    expect(row.impressions).toBe(1200);
    // "Not reported by the platform" and "reported as zero" are different
    // facts, and the learning engine must not confuse them.
    expect(row.saves).toBeNull();
    expect(row.follows).toBeNull();
  });

  it('allows repeated snapshots over time for one item', () => {
    const { contentItemId } = seed(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO analytics_snapshots (content_item_id, source, captured_at, impressions)
       VALUES (?, 'OCR', ?, ?)`,
    );
    insert.run(contentItemId, 1758441600000, 500);
    insert.run(contentItemId, 1758528000000, 1400);

    const count = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM analytics_snapshots WHERE content_item_id = ?`,
      )
      .get(contentItemId) as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('PRD §16 — provenance is queryable', () => {
  it('finds content resting on an unverified claim', () => {
    const { researchItemId, contentItemId } = seed(sqlite);

    const claimId = Number(
      sqlite
        .prepare(
          `INSERT INTO claims (research_item_id, text, claim_type, verification_status)
           VALUES (?, 'Unchecked assertion', 'FACT', 'UNVERIFIED')`,
        )
        .run(researchItemId).lastInsertRowid,
    );

    sqlite
      .prepare(
        `INSERT INTO content_item_sources (content_item_id, claim_id) VALUES (?, ?)`,
      )
      .run(contentItemId, claimId);

    // The query the system relies on as its defence against §57 Risk 2.
    const rows = sqlite
      .prepare(
        `SELECT ci.id
           FROM content_items ci
           JOIN content_item_sources cis ON cis.content_item_id = ci.id
           JOIN claims c ON c.id = cis.claim_id
          WHERE c.verification_status = 'UNVERIFIED'`,
      )
      .all() as Array<{ id: number }>;

    expect(rows.map((r) => r.id)).toEqual([contentItemId]);
  });
});

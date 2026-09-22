import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { brandConfig, systemEvents } from '@/db/schema';
import { PLACEHOLDER_BRAND } from '@/domain/brand';
import { seed } from '@/db/seed';
import {
  BrandError,
  activateBrandVersion,
  activeBrandProvenance,
  brandVersions,
  saveBrandDraft,
} from './brand';
import { activeBrand } from './opportunities';

let sqlite: Database.Database;
let db: DB;

/**
 * A complete production brand.
 *
 * Written out in full rather than spread from the placeholder — the spread is
 * the exact mechanism that once produced a brand voice nobody authored, and a
 * fixture that used it would be testing the wrong thing.
 */
const REAL_BRAND = {
  brandName: 'Test Brand',
  positioning: 'A positioning statement.',
  audiencePrimary: 'A primary audience.',
  audienceSecondary: 'A secondary audience.',
  languagePolicy: 'English by default.',
  voice: {
    traits: ['direct'],
    does: ['Lead with the development.'],
    avoids: ['Hype.'],
    exampleLines: ['A line in the voice.'],
  },
  character: null,
  designSystem: null,
  isPlaceholder: false as const,
};

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('saveBrandDraft', () => {
  it('saves the first version as version 1', () => {
    expect(saveBrandDraft(db, REAL_BRAND).version).toBe(1);
  });

  it('increments the version on each save', () => {
    saveBrandDraft(db, REAL_BRAND);
    saveBrandDraft(db, { ...REAL_BRAND, brandName: 'Second' });
    expect(saveBrandDraft(db, { ...REAL_BRAND, brandName: 'Third' }).version).toBe(3);
  });

  it('preserves older versions rather than overwriting them', () => {
    // §20 wants the brand versioned, so the learning engine can later ask
    // whether performance changed when the voice did.
    saveBrandDraft(db, REAL_BRAND);
    saveBrandDraft(db, { ...REAL_BRAND, brandName: 'Second' });

    expect(brandVersions(db).map((v) => v.version)).toEqual([2, 1]);
  });

  it('records a note against the version', () => {
    saveBrandDraft(db, REAL_BRAND, { note: 'tightened the hooks' });
    expect(brandVersions(db)[0]?.note).toBe('tightened the hooks');
  });

  it('stores no note when none was given', () => {
    saveBrandDraft(db, REAL_BRAND, { note: '   ' });
    expect(brandVersions(db)[0]?.note).toBeNull();
  });
});

describe('A — a placeholder cannot silently become real', () => {
  it('does not activate on save', () => {
    // Saving is inert. This is the property the whole design rests on.
    saveBrandDraft(db, REAL_BRAND);

    expect(brandVersions(db)[0]?.active).toBe(false);
    expect(activeBrand(db).isPlaceholder).toBe(true);
    expect(activeBrandProvenance(db).version).toBeNull();
  });

  it('refuses a production brand that omits a field', () => {
    // The incident: a payload that inherited placeholder content field by
    // field and was stored flagged as real. Nothing may default.
    for (const missing of [
      'positioning',
      'audiencePrimary',
      'audienceSecondary',
      'languagePolicy',
    ] as const) {
      const candidate: Record<string, unknown> = { ...REAL_BRAND };
      delete candidate[missing];
      expect(() => saveBrandDraft(db, candidate)).toThrow(BrandError);
    }
  });

  it('refuses a production brand with an empty field', () => {
    expect(() => saveBrandDraft(db, { ...REAL_BRAND, brandName: '' })).toThrow(
      BrandError,
    );
    expect(() =>
      saveBrandDraft(db, { ...REAL_BRAND, positioning: '   ' }),
    ).toThrow(BrandError);
  });

  it('refuses a production brand with no example lines', () => {
    // The most useful field for generation quality; a real voice without one
    // is a placeholder wearing a name.
    expect(() =>
      saveBrandDraft(db, {
        ...REAL_BRAND,
        voice: { ...REAL_BRAND.voice, exampleLines: [] },
      }),
    ).toThrow(BrandError);
  });

  it('refuses a production brand with no traits, does or avoids', () => {
    for (const key of ['traits', 'does', 'avoids'] as const) {
      expect(() =>
        saveBrandDraft(db, {
          ...REAL_BRAND,
          voice: { ...REAL_BRAND.voice, [key]: [] },
        }),
      ).toThrow(BrandError);
    }
  });

  it('refuses the placeholder itself submitted as a production brand', () => {
    // PLACEHOLDER_BRAND has no example lines, so it cannot pass the
    // production schema even with the flag flipped.
    expect(() =>
      saveBrandDraft(db, { ...PLACEHOLDER_BRAND, isPlaceholder: false }),
    ).toThrow(BrandError);
  });

  it('refuses something that is not a brand config at all', () => {
    expect(() => saveBrandDraft(db, { nonsense: true })).toThrow(BrandError);
  });

  it('writes nothing when validation fails', () => {
    try {
      saveBrandDraft(db, { nonsense: true });
    } catch {
      // expected
    }
    expect(brandVersions(db)).toHaveLength(0);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });
});

describe('C — activation requires an explicit, attributed act', () => {
  it('activates when confirmed by a named person', () => {
    saveBrandDraft(db, REAL_BRAND);
    activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true });

    expect(activeBrand(db).brandName).toBe('Test Brand');
    expect(activeBrand(db).isPlaceholder).toBe(false);
  });

  it('refuses activation with no named actor', () => {
    saveBrandDraft(db, REAL_BRAND);
    expect(() =>
      activateBrandVersion(db, { version: 1, actor: '   ', confirm: true }),
    ).toThrow(/requires the name of the person/);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('refuses activation without explicit confirmation', () => {
    saveBrandDraft(db, REAL_BRAND);
    expect(() =>
      activateBrandVersion(db, {
        version: 1,
        actor: 'jatin',
        confirm: false as unknown as true,
      }),
    ).toThrow(/confirmed explicitly/);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('refuses a version that does not exist', () => {
    expect(() =>
      activateBrandVersion(db, { version: 99, actor: 'jatin', confirm: true }),
    ).toThrow(BrandError);
  });

  it('re-validates at activation, not only at save', () => {
    // A row could have been written by something other than saveBrandDraft.
    // This is the gate that decides what every brief is written in.
    saveBrandDraft(db, REAL_BRAND);
    db.update(brandConfig)
      .set({ payloadJson: JSON.stringify({ brandName: 'only a name' }) })
      .where(eq(brandConfig.version, 1))
      .run();

    expect(() =>
      activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true }),
    ).toThrow(/not a valid brand configuration/);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('keeps exactly one active version', () => {
    // Two would make "the brand voice" ambiguous and activeBrand() would
    // silently pick one.
    saveBrandDraft(db, REAL_BRAND);
    saveBrandDraft(db, { ...REAL_BRAND, brandName: 'Second' });
    activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true });
    activateBrandVersion(db, { version: 2, actor: 'jatin', confirm: true });

    expect(db.select().from(brandConfig).all().filter((r) => r.active)).toHaveLength(1);
    expect(activeBrand(db).brandName).toBe('Second');
  });
});

describe('D — activation is audited', () => {
  it('records version, actor and time as a system event', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    saveBrandDraft(db, REAL_BRAND);
    activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true }, { now });

    const event = db
      .select()
      .from(systemEvents)
      .all()
      .find((e) => e.kind === 'brand_config.activated');

    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload ?? '{}');
    expect(payload.version).toBe(1);
    expect(payload.actor).toBe('jatin');
    expect(payload.activatedAt).toBe(now.getTime());
  });

  it('records the actor on the row itself', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    saveBrandDraft(db, REAL_BRAND);
    activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true }, { now });

    const provenance = activeBrandProvenance(db);
    expect(provenance.version).toBe(1);
    expect(provenance.activatedBy).toBe('jatin');
    expect(provenance.activatedAt).toBe(now.getTime());
    expect(provenance.isPlaceholder).toBe(false);
  });

  it('writes no audit record when activation is refused', () => {
    saveBrandDraft(db, REAL_BRAND);
    try {
      activateBrandVersion(db, { version: 1, actor: '', confirm: true });
    } catch {
      // expected
    }
    expect(
      db.select().from(systemEvents).all().filter((e) => e.kind === 'brand_config.activated'),
    ).toHaveLength(0);
  });
});

describe('B — seed and demo paths cannot produce a production brand', () => {
  let dir: string;
  let url: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smos-brand-'));
    url = join(dir, 'test.db');
    const fresh = new Database(url);
    fresh.pragma('foreign_keys = ON');
    const fdb = drizzle(fresh, { schema }) as unknown as DB;
    migrate(fdb as never, { migrationsFolder: './drizzle' });
    fresh.close();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeding writes no brand configuration at all', () => {
    seed(url);

    const seeded = new Database(url, { readonly: true });
    const rows = seeded
      .prepare('select count(*) as c from brand_config')
      .get() as { c: number };
    seeded.close();

    // The correct BRAND VOICE UNDEFINED state: no row means the placeholder
    // is in use, and §4 leaves the real one to Jatin and ChatGPT.
    expect(rows.c).toBe(0);
  });

  it('no path can activate a brand as a side effect of saving', () => {
    // Whatever writes a draft — a script, a fixture, a form — it is inert
    // until a named human confirms it. That is what makes the seed/demo
    // guarantee structural rather than a matter of those scripts behaving.
    saveBrandDraft(db, REAL_BRAND);
    saveBrandDraft(db, { ...REAL_BRAND, brandName: 'Another' });

    expect(db.select().from(brandConfig).all().every((r) => !r.active)).toBe(true);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });
});

describe('activeBrand', () => {
  it('falls back to the placeholder before anything is activated', () => {
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('is used by briefs once a version is activated', () => {
    saveBrandDraft(db, REAL_BRAND);
    activateBrandVersion(db, { version: 1, actor: 'jatin', confirm: true });

    const brand = activeBrand(db);
    expect(brand.voice.does).toContain('Lead with the development.');
    expect(brand.isPlaceholder).toBe(false);
  });

  it('reports the undefined state honestly when nothing is active', () => {
    saveBrandDraft(db, REAL_BRAND);
    const provenance = activeBrandProvenance(db);

    expect(provenance.version).toBeNull();
    expect(provenance.isPlaceholder).toBe(true);
    expect(provenance.activatedBy).toBeNull();
  });
});

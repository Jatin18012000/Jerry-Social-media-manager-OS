import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { brandConfig } from '@/db/schema';
import { PLACEHOLDER_BRAND } from '@/domain/brand';
import { BrandError, brandVersions, saveBrandVersion } from './brand';
import { activeBrand } from './opportunities';

let sqlite: Database.Database;
let db: DB;

const REAL_BRAND = {
  ...PLACEHOLDER_BRAND,
  brandName: 'Jatin — AI',
  isPlaceholder: false,
  voice: {
    traits: ['direct'],
    does: ['Lead with the development.'],
    avoids: ['Hype.'],
    exampleLines: [],
  },
};

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('saveBrandVersion', () => {
  it('saves the first version as version 1 and activates it', () => {
    const saved = saveBrandVersion(db, REAL_BRAND);
    expect(saved.version).toBe(1);
    expect(activeBrand(db).brandName).toBe('Jatin — AI');
    expect(activeBrand(db).isPlaceholder).toBe(false);
  });

  it('increments the version on each save', () => {
    saveBrandVersion(db, REAL_BRAND);
    saveBrandVersion(db, { ...REAL_BRAND, brandName: 'Second' });
    const third = saveBrandVersion(db, { ...REAL_BRAND, brandName: 'Third' });
    expect(third.version).toBe(3);
  });

  it('keeps exactly one active version', () => {
    // Two active versions would make "the brand voice" ambiguous, and
    // activeBrand() would silently pick one.
    saveBrandVersion(db, REAL_BRAND);
    saveBrandVersion(db, { ...REAL_BRAND, brandName: 'Second' });
    saveBrandVersion(db, { ...REAL_BRAND, brandName: 'Third' });

    const active = db
      .select()
      .from(brandConfig)
      .all()
      .filter((row) => row.active);

    expect(active).toHaveLength(1);
    expect(activeBrand(db).brandName).toBe('Third');
  });

  it('preserves older versions rather than overwriting them', () => {
    // §20 wants the brand versioned, so the learning engine can later ask
    // whether performance changed when the voice did.
    saveBrandVersion(db, REAL_BRAND);
    saveBrandVersion(db, { ...REAL_BRAND, brandName: 'Second' });

    const versions = brandVersions(db);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('records a note against the version', () => {
    saveBrandVersion(db, REAL_BRAND, { note: 'tightened the hooks' });
    expect(brandVersions(db)[0]?.note).toBe('tightened the hooks');
  });

  it('stores no note when none was given', () => {
    saveBrandVersion(db, REAL_BRAND, { note: '   ' });
    expect(brandVersions(db)[0]?.note).toBeNull();
  });
});

describe('saveBrandVersion — validation', () => {
  it('refuses a config with no brand name', () => {
    expect(() =>
      saveBrandVersion(db, { ...REAL_BRAND, brandName: '' }),
    ).toThrow(BrandError);
  });

  it('refuses a voice with no traits', () => {
    expect(() =>
      saveBrandVersion(db, {
        ...REAL_BRAND,
        voice: { ...REAL_BRAND.voice, traits: [] },
      }),
    ).toThrow(BrandError);
  });

  it('refuses something that is not a brand config at all', () => {
    expect(() => saveBrandVersion(db, { nonsense: true })).toThrow(BrandError);
  });

  it('writes nothing when validation fails', () => {
    try {
      saveBrandVersion(db, { nonsense: true });
    } catch {
      // expected
    }
    expect(brandVersions(db)).toHaveLength(0);
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });
});

describe('activeBrand', () => {
  it('falls back to the placeholder before anything is configured', () => {
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('is used by briefs once a real config is saved', () => {
    saveBrandVersion(db, REAL_BRAND);
    const brand = activeBrand(db);
    expect(brand.voice.does).toContain('Lead with the development.');
    expect(brand.isPlaceholder).toBe(false);
  });
});

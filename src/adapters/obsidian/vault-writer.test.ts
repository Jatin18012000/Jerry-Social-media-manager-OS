import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENERATED_START, wrapGenerated } from '@/domain/obsidian';
import {
  VaultError,
  createVaultWriter,
  resolveInside,
  vaultFromEnv,
} from './vault-writer';

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'smos-vault-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe('resolveInside — the containment check', () => {
  it('resolves an ordinary relative path', () => {
    expect(resolveInside(vault, 'Research/1-a.md')).toBe(
      join(vault, 'Research/1-a.md'),
    );
  });

  it('refuses a path that climbs out', () => {
    // slugify already makes this impossible upstream. One layer between an
    // RSS feed and someone's home directory is not enough.
    expect(() => resolveInside(vault, '../escaped.md')).toThrow(VaultError);
    expect(() => resolveInside(vault, 'Research/../../escaped.md')).toThrow(
      VaultError,
    );
  });

  it('refuses an absolute path', () => {
    expect(() => resolveInside(vault, '/etc/passwd')).toThrow(VaultError);
  });

  it('refuses the vault root itself', () => {
    expect(() => resolveInside(vault, '.')).toThrow(VaultError);
    expect(() => resolveInside(vault, '')).toThrow(VaultError);
  });

  it('allows a deep path inside the vault', () => {
    expect(() =>
      resolveInside(vault, 'a/b/c/d/note.md'),
    ).not.toThrow();
  });

  it('says why it refused', () => {
    expect(() => resolveInside(vault, '../x.md')).toThrow(/outside the vault/);
  });
});

describe('createVaultWriter', () => {
  it('refuses an empty vault path', () => {
    expect(() => createVaultWriter('   ')).toThrow(VaultError);
  });

  it('creates a note and the folders it needs', async () => {
    const writer = createVaultWriter(vault);
    const outcome = await writer.write(
      'Social Media OS/Research/1-a.md',
      'body',
    );

    expect(outcome).toBe('CREATED');
    expect(
      await readFile(join(vault, 'Social Media OS/Research/1-a.md'), 'utf8'),
    ).toBe('body');
  });

  it('reports an update on the second write', async () => {
    const writer = createVaultWriter(vault);
    await writer.write('Research/1-a.md', wrapGenerated('first'));
    const outcome = await writer.write('Research/1-a.md', wrapGenerated('second'));
    expect(outcome).toBe('UPDATED');
  });

  it('preserves what the user wrote below the markers', async () => {
    const writer = createVaultWriter(vault);
    const path = 'Research/1-a.md';

    await writer.write(path, wrapGenerated('generated v1'));

    // Jatin annotates the note.
    const file = join(vault, path);
    const withNotes =
      (await readFile(file, 'utf8')) + '\nThis matters because X.\n';
    await writeFile(file, withNotes, 'utf8');

    await writer.write(path, wrapGenerated('generated v2'));

    const after = await readFile(file, 'utf8');
    expect(after).toContain('generated v2');
    expect(after).not.toContain('generated v1');
    expect(after).toContain('This matters because X.');
  });

  it('keeps a hand-written file entirely when it has no markers', async () => {
    const writer = createVaultWriter(vault);
    const path = 'Research/1-a.md';
    const file = join(vault, path);

    // The writer creates the folder; seed the file through it.
    await writer.write(path, 'seed');
    await writeFile(file, '# Entirely mine\n\nMy own research.\n', 'utf8');

    await writer.write(path, 'generated');

    const after = await readFile(file, 'utf8');
    expect(after).toContain('My own research.');
    expect(after).toContain('generated');
    expect(after).toContain(GENERATED_START);
  });

  it('refuses to write outside the vault', async () => {
    const writer = createVaultWriter(vault);
    await expect(writer.write('../escaped.md', 'body')).rejects.toThrow(
      VaultError,
    );
  });

  it('never deletes anything', async () => {
    const writer = createVaultWriter(vault);
    const other = join(vault, 'unrelated.md');
    await writeFile(other, 'untouched', 'utf8');

    await writer.write('Research/1-a.md', wrapGenerated('x'));

    expect(await readFile(other, 'utf8')).toBe('untouched');
  });
});

describe('vaultFromEnv', () => {
  it('returns null when no vault is configured', () => {
    // The normal state. Guessing at a vault location would mean writing files
    // into someone's home directory uninvited.
    expect(vaultFromEnv({})).toBeNull();
    expect(vaultFromEnv({ OBSIDIAN_VAULT_PATH: '   ' })).toBeNull();
  });

  it('builds a writer when one is configured', () => {
    expect(vaultFromEnv({ OBSIDIAN_VAULT_PATH: vault })?.root).toBe(vault);
  });
});

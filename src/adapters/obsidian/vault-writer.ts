/**
 * Writing notes into an Obsidian vault — the automation guide's §10.
 *
 * This is the only code in the system that writes files outside the project
 * directory, to a path the user configures. That makes it the riskiest
 * component here, so it is deliberately narrow:
 *
 *   It refuses to run unless a vault path is explicitly configured. There is
 *   no default and no guessing at where a vault might be.
 *
 *   Every resolved path is checked to be inside the vault before anything is
 *   written. `slugify` already makes traversal impossible, but note titles
 *   come from RSS feeds — arbitrary text from the open internet — and a single
 *   layer between that and someone's home directory is not enough. If the
 *   containment check ever fires, something upstream is broken and the write
 *   must not happen.
 *
 *   It never deletes and never truncates a file it did not fully understand.
 *   Content outside the generated markers is preserved on every write.
 *
 * One-way by construction: there is no read path that feeds the database.
 * §10 says the database stays authoritative, and the absence of an importer
 * is how that is enforced rather than promised.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { mergeGenerated } from '@/domain/obsidian';

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultWriter {
  readonly root: string;
  /** Writes a note, preserving anything the user added outside the markers. */
  write(relativePath: string, generatedBody: string): Promise<'CREATED' | 'UPDATED'>;
}

/**
 * Resolves a vault-relative path and proves it stays inside the vault.
 *
 * Exported for testing: this is the check that matters, and it should be
 * possible to assert it directly rather than only through a write.
 */
export function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new VaultError(
      `Refusing an absolute note path: ${relativePath}`,
    );
  }

  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, target);

  // An empty relative path means the target *is* the root; one starting with
  // '..' means it escaped. Either is a bug upstream, not a user error.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new VaultError(
      `Refusing to write outside the vault: ${relativePath}`,
    );
  }

  return target;
}

export function createVaultWriter(root: string): VaultWriter {
  if (!root.trim()) {
    throw new VaultError('No vault path configured.');
  }

  return {
    root: resolve(root),

    async write(relativePath, generatedBody) {
      const target = resolveInside(root, relativePath);

      await mkdir(dirname(target), { recursive: true });

      let existing: string | null = null;
      try {
        existing = await readFile(target, 'utf8');
      } catch (error) {
        // ENOENT is the normal first-export case. Anything else — a
        // permission problem, a directory where a file should be — is real
        // and must not be mistaken for "new file".
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new VaultError(
            `Could not read ${relativePath}: ${(error as Error).message}`,
          );
        }
      }

      if (existing === null) {
        await writeFile(target, generatedBody, 'utf8');
        return 'CREATED';
      }

      await writeFile(target, mergeGenerated(existing, generatedBody), 'utf8');
      return 'UPDATED';
    },
  };
}

/**
 * Builds a writer from environment, or returns null when no vault is set.
 *
 * Null is the normal state. Obsidian is optional, and a system that guessed
 * at a vault location would be writing files into someone's home directory
 * uninvited.
 */
export function vaultFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VaultWriter | null {
  const path = env['OBSIDIAN_VAULT_PATH'];
  if (!path || !path.trim()) return null;
  return createVaultWriter(path);
}

/** Where each kind of note lives inside the vault. */
export const FOLDERS = {
  research: 'Social Media OS/Research',
  opportunities: 'Social Media OS/Opportunities',
  published: 'Social Media OS/Published',
} as const;

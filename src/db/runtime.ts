/**
 * Process-wide database handle for the running app.
 *
 * Next.js reloads modules in development, so the connection is cached on
 * globalThis to avoid opening a new SQLite handle on every hot reload — which
 * exhausts file descriptors and, under WAL, produces confusing lock errors.
 */

import { createDb, type DB } from './client';

const KEY = Symbol.for('socialmediaos.db');

type GlobalWithDb = typeof globalThis & { [KEY]?: DB };

export function getDb(): DB {
  const store = globalThis as GlobalWithDb;
  if (!store[KEY]) {
    store[KEY] = createDb(process.env.DATABASE_URL ?? './data/os.db');
  }
  return store[KEY];
}

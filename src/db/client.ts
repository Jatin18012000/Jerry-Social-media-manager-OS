/**
 * Database client — SQLite via better-sqlite3 (§34 local-first, D6).
 *
 * The connection is created once per process. Pragmas are set explicitly
 * rather than left to defaults because two of them matter for correctness:
 * foreign keys are OFF by default in SQLite, and WAL mode is what lets the
 * scheduler write while the dashboard reads.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';

export type DB = ReturnType<typeof createDb>;

export function createSqlite(url: string): Database.Database {
  const dir = dirname(url);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(url);

  // Referential integrity is not optional here: provenance (§16) and
  // idempotency (§39) both depend on foreign keys actually being enforced.
  sqlite.pragma('foreign_keys = ON');
  // Concurrent reads while the job runner writes.
  sqlite.pragma('journal_mode = WAL');
  // Durable without the full fsync cost of FULL; safe under WAL.
  sqlite.pragma('synchronous = NORMAL');

  return sqlite;
}

export function createDb(url: string) {
  return drizzle(createSqlite(url), { schema });
}

export { schema };

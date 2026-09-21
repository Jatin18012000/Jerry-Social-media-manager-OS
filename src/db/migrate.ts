/**
 * Applies pending migrations. Run with: npm run db:migrate
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { createDb } from './client';

const url = process.env.DATABASE_URL ?? './data/os.db';
const db = createDb(url);

migrate(db, { migrationsFolder: './drizzle' });

console.log(`Migrations applied to ${url}`);

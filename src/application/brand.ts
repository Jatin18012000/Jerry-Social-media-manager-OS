/**
 * Brand configuration storage — PRD §8, §19, §20.
 *
 * §4 assigns brand and content strategy to ChatGPT and §5 forbids this
 * codebase from setting it. This module stores and versions what Jatin and
 * ChatGPT decide; it proposes none of it.
 */

import { desc, eq } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { brandConfig } from '@/db/schema';
import { type BrandConfig, safeParseBrandConfig } from '@/domain/brand';

export class BrandError extends Error {}

export interface SavedBrand {
  readonly version: number;
  readonly config: BrandConfig;
}

/**
 * Saves a new version and makes it active.
 *
 * A new row rather than an update: §20 wants the brand centralised and
 * versioned, and versioning is what lets the learning engine later answer
 * "did engagement change after the voice changed?". Overwriting would destroy
 * the only evidence for that question.
 */
export function saveBrandVersion(
  db: DB,
  candidate: unknown,
  opts: { note?: string; now?: Date } = {},
): SavedBrand {
  const parsed = safeParseBrandConfig(candidate);
  if (!parsed.ok) throw new BrandError(parsed.error);

  const now = (opts.now ?? new Date()).getTime();

  const latest = db
    .select({ version: brandConfig.version })
    .from(brandConfig)
    .orderBy(desc(brandConfig.version))
    .get();

  const version = (latest?.version ?? 0) + 1;

  db.transaction((tx) => {
    // Exactly one active version, always. Two would make "the brand voice"
    // ambiguous, and activeBrand() would silently pick one.
    tx.update(brandConfig)
      .set({ active: false, updatedAt: now })
      .where(eq(brandConfig.active, true))
      .run();

    tx.insert(brandConfig)
      .values({
        version,
        active: true,
        payloadJson: JSON.stringify(parsed.config),
        note: opts.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  return { version, config: parsed.config };
}

export function brandVersions(db: DB, limit = 10) {
  return db
    .select()
    .from(brandConfig)
    .orderBy(desc(brandConfig.version))
    .limit(limit)
    .all();
}

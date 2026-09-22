import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVaultWriter } from '@/adapters/obsidian/vault-writer';
import { createPublisherRegistry } from '@/adapters/publishers';
import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  claims,
  contentItems,
  contentOpportunities,
  publicationRecords,
  researchItems,
  sources,
} from '@/db/schema';
import type { Platform } from '@/domain/content';
import { saveReading } from './analytics';
import { act, moveTo, verifyClaim } from './content';
import { exportToVault, findOrphans, planExport } from './obsidian-export';
import {
  createContentItem,
  createOpportunity,
  scopedClaimsWithIds,
} from './opportunities';
import { submitForReview } from './qa';
import { confirmManualPublish, runDueJobs, scheduleItem } from './schedule';

let sqlite: Database.Database;
let db: DB;
let vault: string;

const NOW = new Date('2026-09-21T12:00:00Z');
const SLOT = new Date('2026-09-21T13:00:00Z');

const registry = createPublisherRegistry('MANUAL');
const publisherFor = (p: Platform) => registry.for(p);

function researchItem(title: string): number {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'OpenAI Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  const id = db
    .insert(researchItems)
    .values({
      sourceId,
      title,
      summary: 'A summary.',
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
      relevanceScore: 0.8,
    })
    .returning({ id: researchItems.id })
    .get().id;

  return id;
}

/** An item taken all the way to PUBLISHED, so the published folder has input. */
async function publishedItem(topic: string): Promise<number> {
  const researchItemId = researchItem(topic);

  db.insert(claims)
    .values({ researchItemId, text: 'A thing happened.', claimType: 'FACT' })
    .run();

  const opportunityId = createOpportunity(db, {
    title: topic,
    researchItemIds: [researchItemId],
  });

  const id = createContentItem(db, {
    opportunityId,
    platform: 'INSTAGRAM',
    format: 'REEL',
    topic,
  });

  for (const claim of scopedClaimsWithIds(db, id)) {
    verifyClaim(db, claim.id, {
      status: 'VERIFIED',
      evidenceUrl: 'https://example.com/e',
      evidenceTier: 'PRIMARY',
      verifiedBy: 'jatin',
    });
  }

  db.update(contentItems)
    .set({
      hook: 'Hook.',
      body: 'Body.',
      caption: 'Caption.',
      cta: 'Follow.',
      hashtags: 'ai',
      altText: 'Alt.',
    })
    .where(eq(contentItems.id, id))
    .run();

  moveTo(db, id, 'RESEARCHING');
  moveTo(db, id, 'RESEARCH_VERIFIED');
  moveTo(db, id, 'STRATEGY_READY');
  moveTo(db, id, 'GENERATING');
  moveTo(db, id, 'QA');
  submitForReview(db, id);
  act(db, id, 'APPROVE', { actor: 'jatin' });
  scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
  await runDueJobs(db, publisherFor, { now: SLOT });
  confirmManualPublish(db, { contentItemId: id, confirmedBy: 'jatin', now: SLOT });

  return id;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
  vault = await mkdtemp(join(tmpdir(), 'smos-export-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe('planExport', () => {
  it('plans nothing for an empty database', () => {
    expect(planExport(db)).toEqual([]);
  });

  it('plans a note per research item, under the namespaced folder', () => {
    researchItem('OpenAI ships a model');
    const planned = planExport(db);

    expect(planned).toHaveLength(1);
    expect(planned[0]!.path).toBe(
      'Social Media OS/Research/1-openai-ships-a-model.md',
    );
    expect(planned[0]!.folder).toBe('research');
  });

  it('keeps a hostile research title inside its folder', () => {
    // Titles come from RSS. This is the whole reason the path is built from
    // an id plus a slug rather than from the title.
    researchItem('../../.ssh/authorized_keys');
    const path = planExport(db)[0]!.path;

    expect(path).not.toContain('..');
    expect(path.startsWith('Social Media OS/Research/')).toBe(true);
    expect(path.split('/')).toHaveLength(3);
  });

  it('touches the filesystem not at all', async () => {
    researchItem('A thing');
    planExport(db);
    // A planning bug should not be able to leave a half-written vault.
    await expect(readFile(join(vault, 'Social Media OS'), 'utf8')).rejects.toThrow();
  });

  it('plans research, opportunity and published notes for one flow', async () => {
    await publishedItem('A launch');
    const folders = planExport(db).map((n) => n.folder);

    expect(folders).toContain('research');
    expect(folders).toContain('opportunities');
    expect(folders).toContain('published');
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i += 1) researchItem(`Item ${i}`);
    expect(planExport(db, 2)).toHaveLength(2);
  });
});

describe('findOrphans — reported, never deleted', () => {
  it('finds nothing in a vault that matches the database', async () => {
    researchItem('A thing');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    expect(await findOrphans(db, writer)).toEqual([]);
  });

  it('reports a note whose research item was deleted', async () => {
    const id = researchItem('A thing');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    db.delete(researchItems).where(eq(researchItems.id, id)).run();

    const orphans = await findOrphans(db, writer);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.id).toBe(id);
    expect(orphans[0]!.folder).toBe('research');
    expect(orphans[0]!.path).toContain('Social Media OS/Research/');
  });

  it('leaves the orphaned file exactly where it is', async () => {
    // A projection that reached back into the vault to delete could destroy a
    // note someone had rewritten. Reporting gives visibility without taking
    // the decision.
    const id = researchItem('A thing');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);
    const file = join(vault, `Social Media OS/Research/${id}-a-thing.md`);
    const before = await readFile(file, 'utf8');

    db.delete(researchItems).where(eq(researchItems.id, id)).run();
    await findOrphans(db, writer);

    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not flag a note merely because the export was capped', async () => {
    // The trap this feature could most easily fall into: comparing the vault
    // against the last batch rather than against the database would declare
    // every note beyond the limit an orphan, and invite deleting notes whose
    // rows are perfectly intact.
    for (let i = 0; i < 5; i += 1) researchItem(`Item ${i}`);
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    // A later export sees only the newest two. The other three are untouched
    // in the vault and alive in the database.
    const report = await exportToVault(db, writer, 2);

    expect(report.orphans).toEqual([]);
  });

  it('ignores a file a person put there themselves', async () => {
    // Not ours to reason about, and certainly not ours to call an orphan.
    const writer = createVaultWriter(vault);
    await writer.write('Social Media OS/Research/my-own-thinking.md', 'Mine.');

    expect(await findOrphans(db, writer)).toEqual([]);
  });

  it('ignores a note of ours that someone renamed', async () => {
    const id = researchItem('A thing');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);
    db.delete(researchItems).where(eq(researchItems.id, id)).run();

    // Renamed out of the managed shape — we can no longer know what it was.
    await writer.write('Social Media OS/Research/notes-on-openai.md', 'Mine.');
    const orphans = await findOrphans(db, writer);

    expect(orphans.map((o) => o.path)).not.toContain(
      'Social Media OS/Research/notes-on-openai.md',
    );
  });

  it('finds orphans across every managed folder', async () => {
    await publishedItem('A launch');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    // Tear the whole chain down, children before parents — the same order
    // db:clean uses, for the same foreign-key reasons.
    db.delete(schema.notifications).run();
    db.delete(schema.agentRuns).run();
    db.delete(schema.generations).run();
    db.delete(schema.briefs).run();
    db.delete(schema.mediaAssets).run();
    db.delete(schema.learningFindings).run();
    db.delete(schema.contentExperiments).run();
    db.delete(schema.analyticsSnapshots).run();
    db.delete(publicationRecords).run();
    db.delete(schema.scheduleJobs).run();
    db.delete(schema.approvalEvents).run();
    db.delete(schema.contentItemSources).run();
    db.delete(contentItems).run();
    db.delete(schema.opportunityResearch).run();
    db.delete(contentOpportunities).run();
    db.delete(claims).run();
    db.delete(researchItems).run();

    const folders = (await findOrphans(db, writer)).map((o) => o.folder);
    expect(folders).toContain('research');
    expect(folders).toContain('opportunities');
    expect(folders).toContain('published');
  });

  it('treats an unpublished item as an orphan of the published folder', async () => {
    // The note exists because there was a publication record. Without one it
    // would no longer be produced, so it is stale in the same way.
    const id = await publishedItem('A launch');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    db.delete(publicationRecords)
      .where(eq(publicationRecords.contentItemId, id))
      .run();

    const orphans = await findOrphans(db, writer);
    expect(orphans.some((o) => o.folder === 'published' && o.id === id)).toBe(true);
  });

  it('reports an empty vault as having no orphans', async () => {
    expect(await findOrphans(db, createVaultWriter(vault))).toEqual([]);
  });
});

describe('exportToVault', () => {
  it('reports what it created', async () => {
    researchItem('A thing');
    const report = await exportToVault(db, createVaultWriter(vault));

    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.failed).toEqual([]);
    expect(report.byFolder.research).toBe(1);
    expect(report.vaultRoot).toBe(vault);
    // A note this run just created is never an orphan of that run.
    expect(report.orphans).toEqual([]);
  });

  it('writes a readable note', async () => {
    const id = researchItem('OpenAI: a new model');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    const md = await readFile(
      join(vault, `Social Media OS/Research/${id}-openai-a-new-model.md`),
      'utf8',
    );

    // The colon would break naive frontmatter and hide the whole block.
    expect(md).toContain('title: "OpenAI: a new model"');
    expect(md).toContain('source_tier: "PRIMARY"');
  });

  it('updates rather than duplicates on a second run', async () => {
    researchItem('A thing');
    const writer = createVaultWriter(vault);

    await exportToVault(db, writer);
    const second = await exportToVault(db, writer);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
  });

  it('preserves notes Jatin added, across a re-export', async () => {
    const id = researchItem('A thing');
    const writer = createVaultWriter(vault);
    await exportToVault(db, writer);

    const file = join(vault, `Social Media OS/Research/${id}-a-thing.md`);
    await writeFile(
      file,
      (await readFile(file, 'utf8')) + '\nWorth a LinkedIn post.\n',
      'utf8',
    );

    // The claim arrives after the note was first written, so the generated
    // region genuinely changes on the second export.
    db.insert(claims)
      .values({ researchItemId: id, text: 'A fact.', claimType: 'FACT' })
      .run();
    await exportToVault(db, writer);

    const after = await readFile(file, 'utf8');
    expect(after).toContain('A fact.');
    expect(after).toContain('Worth a LinkedIn post.');
  });

  it('shows §7.3 claim types distinctly rather than flattening them', async () => {
    const id = researchItem('A thing');
    db.insert(claims)
      .values([
        { researchItemId: id, text: 'It shipped.', claimType: 'FACT' },
        { researchItemId: id, text: 'It will win.', claimType: 'PREDICTION' },
      ])
      .run();

    await exportToVault(db, createVaultWriter(vault));
    const md = await readFile(
      join(vault, `Social Media OS/Research/${id}-a-thing.md`),
      'utf8',
    );

    expect(md).toContain('**FACT**');
    expect(md).toContain('**PREDICTION**');
    expect(md).toContain('unverified');
  });

  it('says no metrics rather than writing zeroes', async () => {
    const id = await publishedItem('A launch');
    await exportToVault(db, createVaultWriter(vault));

    const md = await readFile(
      join(vault, `Social Media OS/Published/${id}-a-launch.md`),
      'utf8',
    );
    expect(md).toContain('No metrics captured yet.');
  });

  it('renders an unreported metric as a dash, never zero', async () => {
    // §40 reaches the vault: a 0 here would read as a post nobody saw, which
    // is a different fact from one the platform declined to report.
    const id = await publishedItem('A launch');
    saveReading(db, {
      contentItemId: id,
      metrics: { impressions: 5000, follows: 20 },
      source: 'MANUAL',
      confirmedBy: 'jatin',
      now: SLOT,
    });

    await exportToVault(db, createVaultWriter(vault));
    const md = await readFile(
      join(vault, `Social Media OS/Published/${id}-a-launch.md`),
      'utf8',
    );

    expect(md).toContain('| Comments | — |');
    expect(md).not.toContain('| Comments | 0 |');
    expect(md).toContain('follows_per_1k: 4');
  });

  it('links a published note back to its opportunity', async () => {
    const id = await publishedItem('A launch');
    await exportToVault(db, createVaultWriter(vault));

    const md = await readFile(
      join(vault, `Social Media OS/Published/${id}-a-launch.md`),
      'utf8',
    );
    expect(md).toContain('[[1-a-launch|A launch]]');
  });

  it('reports a failure without abandoning the other notes', async () => {
    researchItem('First');
    researchItem('Second');

    const writer = createVaultWriter(vault);
    let calls = 0;
    const flaky = {
      root: writer.root,
      write: async (path: string, body: string) => {
        calls += 1;
        if (calls === 1) throw new Error('EACCES');
        return writer.write(path, body);
      },
      list: (folder: string) => writer.list(folder),
    };

    const report = await exportToVault(db, flaky);

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toContain('EACCES');
    // One bad file is not a reason to leave the rest stale.
    expect(report.created).toBe(1);
  });
});

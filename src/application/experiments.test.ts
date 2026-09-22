import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createPublisherRegistry } from '@/adapters/publishers';
import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  claims,
  contentItems,
  experiments,
  learningFindings,
  researchItems,
  sources,
} from '@/db/schema';
import type { Platform } from '@/domain/content';
import { saveReading } from './analytics';
import { act, moveTo, verifyClaim } from './content';
import {
  ExperimentError,
  abandonExperiment,
  armValues,
  assignVariant,
  assignableItems,
  concludeExperiment,
  conclusionBlocker,
  createExperiment,
  experimentDetail,
  experimentFindings,
  listExperiments,
  startExperiment,
  unassignVariant,
} from './experiments';
import { analyseAll } from '@/domain/learning';
import { recomputeFindings } from './learning';
import {
  createContentItem,
  createOpportunity,
  scopedClaimsWithIds,
} from './opportunities';
import { submitForReview } from './qa';
import { confirmManualPublish, runDueJobs, scheduleItem } from './schedule';

let sqlite: Database.Database;
let db: DB;

/**
 * The existing suite runs with experiments explicitly ACTIVE.
 *
 * Shelving is a launch-phase product decision, not a removal: the
 * infrastructure must stay compiled, reachable and proven, so these tests
 * opt in rather than being deleted or skipped.
 */
const ACTIVE = { shelved: false } as const;

const NOW = new Date('2026-09-21T12:00:00Z');
const SLOT = new Date('2026-09-21T13:00:00Z');

const registry = createPublisherRegistry('MANUAL');
const publisherFor = (p: Platform) => registry.for(p);

const GOOD = {
  hypothesis: 'Hinglish captions earn more follows than English ones.',
  metric: 'follows/1k',
  controlName: 'English',
  controlDescription: 'Caption written entirely in English.',
  treatmentName: 'Hinglish',
  treatmentDescription: 'Caption mixing Hindi and English as spoken.',
  minSampleSize: 5,
};

/** An item taken to PUBLISHED, optionally with metrics captured. */
async function publishedItem(
  topic: string,
  metrics?: { impressions: number; follows: number },
): Promise<number> {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  const researchItemId = db
    .insert(researchItems)
    .values({
      sourceId,
      title: topic,
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;

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

  if (metrics) {
    saveReading(db, {
      contentItemId: id,
      metrics,
      source: 'MANUAL',
      confirmedBy: 'jatin',
      now: SLOT,
    });
  }

  return id;
}

/** A started experiment. */
function running(overrides: Partial<typeof GOOD> = {}): number {
  const created = createExperiment(db, { ...GOOD, ...overrides }, { now: NOW, shelved: false });
  if (!created.ok || created.id === undefined) {
    throw new Error(`fixture failed: ${created.errors?.join('; ')}`);
  }
  startExperiment(db, created.id, { now: NOW, shelved: false });
  return created.id;
}

/**
 * Fills an arm with n measured items, in the order a real experiment runs.
 *
 * Assign, then publish, then measure. The system refuses to enrol an item
 * whose metrics already exist, so this fixture has to follow the real
 * workflow rather than fabricating rows in a convenient order.
 *
 * `follows` drives follows/1k, so a higher value makes that arm win.
 */
async function fill(
  experimentId: number,
  variant: string,
  count: number,
  follows: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = await publishedItem(`${variant} ${i} ${Math.random()}`);
    assignVariant(db, { experimentId, contentItemId: id, variant });
    saveReading(db, {
      contentItemId: id,
      metrics: {
        impressions: 1000,
        // A little spread, or the variance is zero and no interval exists.
        follows: follows + (i % 2 === 0 ? 1 : -1),
      },
      source: 'MANUAL',
      confirmedBy: 'jatin',
      now: SLOT,
    });
    ids.push(id);
  }
  return ids;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('E — experiments refuse to run while SHELVED', () => {
  it('refuses to create an experiment', () => {
    expect(() => createExperiment(db, GOOD, { now: NOW, shelved: true })).toThrow(
      /shelved for the initial launch phase/,
    );
  });

  it('writes nothing when creation is refused', () => {
    try {
      createExperiment(db, GOOD, { now: NOW, shelved: true });
    } catch {
      // expected
    }
    expect(db.select().from(experiments).all()).toHaveLength(0);
  });

  it('refuses to start an experiment', () => {
    const created = createExperiment(db, GOOD, { now: NOW, ...ACTIVE });
    expect(() =>
      startExperiment(db, created.id!, { now: NOW, shelved: true }),
    ).toThrow(/shelved for the initial launch phase/);
    expect(db.select().from(experiments).get()?.status).toBe('DRAFT');
  });

  it('says how to re-enable, and that nothing was deleted', () => {
    expect(() => createExperiment(db, GOOD, { now: NOW, shelved: true })).toThrow(
      /EXPERIMENTS_MODE=ACTIVE/,
    );
    expect(() => createExperiment(db, GOOD, { now: NOW, shelved: true })).toThrow(
      /nothing has been deleted/i,
    );
  });

  it('still allows reading and concluding a running experiment', async () => {
    // An experiment already running when the mode changed must stay readable
    // and closable. Stranding real data behind a flag would be worse than
    // never having run it.
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);

    expect(listExperiments(db)).toHaveLength(1);
    expect(conclusionBlocker(db, id)).toBeNull();
    expect(concludeExperiment(db, id, { now: SLOT }).conclusion.verdict).toBe(
      'SUPPORTED',
    );
  });

  it('leaves §29 exactly where it was', () => {
    // Shelving removes the ability to run an experiment. It does not lower
    // the bar for concluding without one: observational analysis still
    // cannot reach SUPPORTED, however large the effect or the sample.
    const observations = Array.from({ length: 60 }, (_, i) => ({
      contentItemId: i + 1,
      value: i % 2 === 0 ? 100 : 1,
      dimensions: { language: i % 2 === 0 ? 'HINGLISH' : 'EN' },
    }));

    const findings = analyseAll(observations, 'follows/1k');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.status === 'SUPPORTED')).toBe(false);
  });
});

describe('createExperiment', () => {
  it('registers a draft', () => {
    const created = createExperiment(db, GOOD, { now: NOW, shelved: false });
    expect(created.ok).toBe(true);

    const record = db.select().from(experiments).get();
    expect(record?.status).toBe('DRAFT');
    expect(record?.minSampleSize).toBe(5);
    expect(record?.verdict).toBeNull();
  });

  it('refuses an incomplete registration and says what is missing', () => {
    const created = createExperiment(db, { hypothesis: 'x' }, { now: NOW, shelved: false });
    expect(created.ok).toBe(false);
    expect(created.errors?.length).toBeGreaterThan(2);
    // Nothing is stored, so a half-registered experiment cannot be started.
    expect(db.select().from(experiments).all()).toHaveLength(0);
  });

  it('refuses a metric the learning engine cannot compute', () => {
    // Validated at creation rather than at start, so an experiment cannot sit
    // in the list looking ready when it could never be concluded.
    const created = createExperiment(db, { ...GOOD, metric: 'vibes' }, { now: NOW, shelved: false });
    expect(created.ok).toBe(false);
  });
});

describe('startExperiment', () => {
  it('starts a draft and stamps the start time', () => {
    const created = createExperiment(db, GOOD, { now: NOW, shelved: false });
    startExperiment(db, created.id!, { now: NOW, shelved: false });

    const record = db.select().from(experiments).get();
    expect(record?.status).toBe('RUNNING');
    expect(record?.startAt).toBe(NOW.getTime());
  });

  it('will not start the same experiment twice', () => {
    const id = running();
    expect(() => startExperiment(db, id, { now: NOW, shelved: false })).toThrow(ExperimentError);
  });

  it('will not start an abandoned experiment', () => {
    const created = createExperiment(db, GOOD, { now: NOW, shelved: false });
    abandonExperiment(db, created.id!, 'changed my mind', { now: NOW });
    expect(() => startExperiment(db, created.id!, { now: NOW, shelved: false })).toThrow(
      ExperimentError,
    );
  });

  it('refuses an experiment that does not exist', () => {
    expect(() => startExperiment(db, 999, { now: NOW, shelved: false })).toThrow(ExperimentError);
  });
});

describe('assignVariant', () => {
  it('assigns an item to an arm', async () => {
    const id = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'Hinglish' });

    expect(experimentDetail(db, id).assignments).toHaveLength(1);
  });

  it('stores the arm as registered, not as typed', async () => {
    const id = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: '  hinglish ' });

    expect(experimentDetail(db, id).assignments[0]!.variant).toBe('Hinglish');
  });

  it('refuses an arm nobody registered', async () => {
    // A typo must not silently create a third arm.
    const id = running();
    const itemId = await publishedItem('A post');
    expect(() =>
      assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'Hinglsh' }),
    ).toThrow(/not an arm of this experiment/);
  });

  it('refuses to assign to a draft', async () => {
    // Data before the terms are fixed is not a pre-registered experiment.
    const created = createExperiment(db, GOOD, { now: NOW, shelved: false });
    const itemId = await publishedItem('A post');
    expect(() =>
      assignVariant(db, {
        experimentId: created.id!,
        contentItemId: itemId,
        variant: 'Hinglish',
      }),
    ).toThrow(/not taking assignments/);
  });

  it('refuses to assign to a concluded experiment', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    const itemId = await publishedItem('A late post');
    expect(() =>
      assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'Hinglish' }),
    ).toThrow(/not taking assignments/);
  });

  it('refuses to move an item between arms', async () => {
    // Reassigning after measurement is choosing where to put a data point
    // once its value is known.
    const id = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    expect(() =>
      assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'Hinglish' }),
    ).toThrow(/already in this experiment/);
  });

  it('refuses an item already in another running experiment', async () => {
    // Two experiments over the same posts confound each other.
    const first = running();
    const second = running({ hypothesis: 'A different claim about captions.' });
    const itemId = await publishedItem('A post');

    assignVariant(db, { experimentId: first, contentItemId: itemId, variant: 'English' });
    expect(() =>
      assignVariant(db, { experimentId: second, contentItemId: itemId, variant: 'English' }),
    ).toThrow(/confound/);
  });

  it('allows an item whose other experiment has concluded', async () => {
    const first = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: first, contentItemId: itemId, variant: 'English' });

    await fill(first, 'English', 5, 10);
    await fill(first, 'Hinglish', 5, 40);
    concludeExperiment(db, first, { now: SLOT });

    // The first is over, so it no longer confounds anything — and this item
    // was never measured, so enrolling it chooses nothing.
    const second = running({ hypothesis: 'A second claim worth testing here.' });
    expect(() =>
      assignVariant(db, { experimentId: second, contentItemId: itemId, variant: 'English' }),
    ).not.toThrow();
  });

  it('refuses an item that has already been measured', async () => {
    // Its result is known, so enrolling it means choosing a data point by its
    // outcome — optional stopping performed at the other end.
    const id = running();
    const itemId = await publishedItem('Already measured', {
      impressions: 1000,
      follows: 40,
    });

    expect(() =>
      assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'Hinglish' }),
    ).toThrow(/already been measured/);
  });

  it('refuses a content item that does not exist', () => {
    const id = running();
    expect(() =>
      assignVariant(db, { experimentId: id, contentItemId: 999, variant: 'English' }),
    ).toThrow(ExperimentError);
  });
});

describe('unassignVariant', () => {
  it('removes an unmeasured item', async () => {
    const id = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    unassignVariant(db, { experimentId: id, contentItemId: itemId });
    expect(experimentDetail(db, id).assignments).toHaveLength(0);
  });

  it('refuses to remove an item that has been measured', async () => {
    // Dropping a data point whose value you already know is the same
    // manoeuvre as moving it.
    const id = running();
    const itemId = await publishedItem('A post');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });
    saveReading(db, {
      contentItemId: itemId,
      metrics: { impressions: 1000, follows: 30 },
      source: 'MANUAL',
      confirmedBy: 'jatin',
      now: SLOT,
    });

    expect(() => unassignVariant(db, { experimentId: id, contentItemId: itemId })).toThrow(
      /already been measured/,
    );
  });
});

describe('armValues — §40 reaches the arms', () => {
  it('splits measured values by arm', async () => {
    const id = running();
    await fill(id, 'English', 3, 10);
    await fill(id, 'Hinglish', 2, 40);

    const values = armValues(db, id);
    expect(values.control).toHaveLength(3);
    expect(values.treatment).toHaveLength(2);
  });

  it('counts an unpublished item as pending, not as zero', async () => {
    const id = running();
    const opportunityId = createOpportunity(db, { title: 'Unpublished', researchItemIds: [] });
    const itemId = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    const values = armValues(db, id);
    expect(values.control).toHaveLength(0);
    expect(values.pending).toBe(1);
  });

  it('counts a published item with no metrics as pending', async () => {
    const id = running();
    const itemId = await publishedItem('No metrics yet');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    expect(armValues(db, id).pending).toBe(1);
  });

  it('counts an unreported metric as pending rather than a zero result', async () => {
    // A post the platform did not report on is not a post that performed at
    // zero, and averaging it in as one would drag the arm down.
    const id = running();
    const itemId = await publishedItem('Reported partially');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });
    saveReading(db, {
      contentItemId: itemId,
      metrics: { likes: 10 },
      source: 'MANUAL',
      confirmedBy: 'jatin',
      now: SLOT,
    });

    const values = armValues(db, id);
    expect(values.control).toHaveLength(0);
    expect(values.pending).toBe(1);
  });
});

describe('conclusionBlocker — no optional stopping', () => {
  it('blocks while an arm is short of the registered minimum', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 2, 40);

    expect(conclusionBlocker(db, id)).toContain('Hinglish has 2 of 5');
  });

  it('clears once both arms are full', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);

    expect(conclusionBlocker(db, id)).toBeNull();
  });

  it('will not let pending items count toward the minimum', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 4, 40);
    // A fifth treatment post exists but has no metrics.
    const unmeasured = await publishedItem('Pending');
    assignVariant(db, { experimentId: id, contentItemId: unmeasured, variant: 'Hinglish' });

    expect(conclusionBlocker(db, id)).toContain('Hinglish has 4 of 5');
  });
});

describe('concludeExperiment', () => {
  it('refuses to conclude early', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 2, 40);

    expect(() => concludeExperiment(db, id, { now: SLOT })).toThrow(ExperimentError);
    // Nothing was written, so the experiment is still live.
    expect(db.select().from(experiments).get()?.status).toBe('RUNNING');
  });

  it('records a SUPPORTED verdict and earns a finding', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);

    const report = concludeExperiment(db, id, { now: SLOT });

    expect(report.conclusion.verdict).toBe('SUPPORTED');
    expect(report.findingId).not.toBeNull();

    const record = db.select().from(experiments).get();
    expect(record?.status).toBe('CONCLUDED');
    expect(record?.verdict).toBe('SUPPORTED');
    expect(record?.endAt).toBe(SLOT.getTime());
  });

  it('is the only route to a SUPPORTED finding', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    const supported = db
      .select()
      .from(learningFindings)
      .where(eq(learningFindings.status, 'SUPPORTED'))
      .all();

    expect(supported).toHaveLength(1);
    // Traceable back to the experiment that earned it.
    expect(supported[0]!.experimentId).toBe(id);
  });

  it('records a REFUTED verdict and earns no finding', async () => {
    // The result is kept where the terms that produced it are visible, not
    // promoted into something the system believes.
    const id = running();
    await fill(id, 'English', 5, 40);
    await fill(id, 'Hinglish', 5, 10);

    const report = concludeExperiment(db, id, { now: SLOT });

    expect(report.conclusion.verdict).toBe('REFUTED');
    expect(report.findingId).toBeNull();
    expect(db.select().from(experiments).get()?.verdict).toBe('REFUTED');
    expect(db.select().from(learningFindings).all()).toHaveLength(0);
  });

  it('records an INCONCLUSIVE verdict rather than discarding it', async () => {
    const id = running();
    await fill(id, 'English', 5, 20);
    await fill(id, 'Hinglish', 5, 20);

    const report = concludeExperiment(db, id, { now: SLOT });

    expect(report.conclusion.verdict).toBe('INCONCLUSIVE');
    expect(report.findingId).toBeNull();
    // A null result is a result: it is stored and findable.
    expect(db.select().from(experiments).get()?.result).toContain(
      'Not evidence that they are the same',
    );
  });

  it('will not conclude the same experiment twice', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    expect(() => concludeExperiment(db, id, { now: SLOT })).toThrow(ExperimentError);
  });

  it('logs the verdict to system events', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    const events = db.select().from(schema.systemEvents).all();
    expect(events.some((e) => e.kind === 'experiment.concluded')).toBe(true);
  });
});

describe('a SUPPORTED finding survives recomputation', () => {
  it('is not deleted when observational findings are replaced', async () => {
    // Without this, the one status that costs an experiment to obtain would
    // be destroyed the moment new analytics arrived.
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    recomputeFindings(db, 'follows/1k', { now: SLOT });

    const supported = db
      .select()
      .from(learningFindings)
      .where(eq(learningFindings.status, 'SUPPORTED'))
      .all();
    expect(supported).toHaveLength(1);
  });

  it('still lets observational findings be replaced', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    recomputeFindings(db, 'follows/1k', { now: SLOT });
    const first = db.select().from(learningFindings).all().length;
    recomputeFindings(db, 'follows/1k', { now: SLOT });
    const second = db.select().from(learningFindings).all().length;

    // Replaced, not accumulated.
    expect(second).toBe(first);
  });

  it('reports experiment-derived findings separately', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });
    recomputeFindings(db, 'follows/1k', { now: SLOT });

    const earned = experimentFindings(db);
    expect(earned).toHaveLength(1);
    expect(earned[0]!.status).toBe('SUPPORTED');
  });
});

describe('abandonExperiment', () => {
  it('abandons a running experiment without a verdict', async () => {
    // An abandoned experiment produced no result, and recording one would be
    // indistinguishable from an inconclusive test that actually ran.
    const id = running();
    await fill(id, 'English', 5, 10);

    abandonExperiment(db, id, 'Ran out of runway', { now: SLOT });

    const record = db.select().from(experiments).get();
    expect(record?.status).toBe('ABANDONED');
    expect(record?.verdict).toBeNull();
    expect(record?.result).toBe('Ran out of runway');
  });

  it('will not abandon a concluded experiment', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 5, 40);
    concludeExperiment(db, id, { now: SLOT });

    expect(() => abandonExperiment(db, id, 'x', { now: SLOT })).toThrow(
      ExperimentError,
    );
  });

  it('notes when no reason was given', () => {
    const id = running();
    abandonExperiment(db, id, '   ', { now: SLOT });
    expect(db.select().from(experiments).get()?.result).toContain(
      'without a reason',
    );
  });
});

describe('reads for the UI', () => {
  it('lists an experiment with both arm counts and its blocker', async () => {
    const id = running();
    await fill(id, 'English', 5, 10);
    await fill(id, 'Hinglish', 1, 40);

    const [summary] = listExperiments(db);
    expect(summary?.controlCount).toBe(5);
    expect(summary?.treatmentCount).toBe(1);
    expect(summary?.blocker).toContain('Hinglish has 1 of 5');
  });

  it('shows an unmeasured assignment with a null value, never 0', async () => {
    const id = running();
    const itemId = await publishedItem('Pending');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    expect(experimentDetail(db, id).assignments[0]!.value).toBeNull();
  });

  it('surfaces an unreadable definition rather than hiding the experiment', () => {
    // An experiment whose terms cannot be read must be visibly unusable.
    const id = running();
    db.update(experiments)
      .set({ variantDefinition: 'not json' })
      .where(eq(experiments.id, id))
      .run();

    const [summary] = listExperiments(db);
    expect(summary?.controlName).toBe('(unreadable)');
    expect(summary?.blocker).toContain('cannot be read');
  });

  it('excludes items already in another running experiment', async () => {
    const first = running();
    const second = running({ hypothesis: 'Another claim worth testing here.' });
    const itemId = await publishedItem('Taken');
    assignVariant(db, { experimentId: first, contentItemId: itemId, variant: 'English' });

    const ids = assignableItems(db, second).map((i) => i.id);
    expect(ids).not.toContain(itemId);
    expect(ids).not.toContain(itemId);
  });

  it('excludes items already in this experiment', async () => {
    const id = running();
    const itemId = await publishedItem('Mine');
    assignVariant(db, { experimentId: id, contentItemId: itemId, variant: 'English' });

    expect(assignableItems(db, id).map((i) => i.id)).not.toContain(itemId);
  });

  it('does not offer an item whose result is already known', async () => {
    const id = running();
    const itemId = await publishedItem('Measured', {
      impressions: 1000,
      follows: 40,
    });

    expect(assignableItems(db, id).map((i) => i.id)).not.toContain(itemId);
  });

  it('offers unpublished items, because assigning before publishing is the point', async () => {
    const id = running();
    const opportunityId = createOpportunity(db, { title: 'Draft', researchItemIds: [] });
    const itemId = createContentItem(db, {
      opportunityId,
      platform: 'LINKEDIN',
      format: 'TEXT',
    });

    expect(assignableItems(db, id).map((i) => i.id)).toContain(itemId);
  });
});

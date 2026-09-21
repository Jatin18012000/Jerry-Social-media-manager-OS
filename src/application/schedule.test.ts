import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  claims,
  contentItems,
  publicationRecords,
  researchItems,
  scheduleJobs,
  sources,
  systemEvents,
} from '@/db/schema';
import { createPublisherRegistry } from '@/adapters/publishers';
import type { Platform } from '@/domain/content';
import type { PublishResult, Publisher } from '@/ports';
import { act, historyOf, moveTo, verifyClaim } from './content';
import {
  createContentItem,
  createOpportunity,
  scopedClaimsWithIds,
} from './opportunities';
import { submitForReview } from './qa';
import {
  ScheduleError,
  confirmManualPublish,
  jobsNeedingAttention,
  resolveMissedJob,
  runDueJobs,
  scheduleItem,
  unscheduleItem,
  upcomingJobs,
} from './schedule';

let sqlite: Database.Database;
let db: DB;

const NOW = new Date('2026-09-21T12:00:00Z');
const SLOT = new Date('2026-09-21T13:00:00Z');

/** A publisher whose outcome the test dictates. */
function stubPublisher(result: PublishResult): Publisher {
  return {
    name: 'stub',
    kind: 'MANUAL',
    supports: () => true,
    publish: async () => result,
  };
}

const manualRegistry = createPublisherRegistry('MANUAL');
const manualFor = (p: Platform) => manualRegistry.for(p);

/** Builds an item all the way to APPROVED, the only state §22 allows scheduling from. */
function approvedItem(): number {
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
      title: 'A thing happened',
      url: `https://example.com/item-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;

  db.insert(claims)
    .values({
      researchItemId,
      text: 'A thing happened.',
      claimType: 'FACT',
    })
    .run();

  const opportunityId = createOpportunity(db, {
    title: 'A thing',
    researchItemIds: [researchItemId],
  });

  const id = createContentItem(db, {
    opportunityId,
    platform: 'INSTAGRAM',
    format: 'REEL',
  });

  for (const claim of scopedClaimsWithIds(db, id)) {
    verifyClaim(db, claim.id, {
      status: 'VERIFIED',
      evidenceUrl: 'https://example.com/evidence',
      evidenceTier: 'PRIMARY',
      verifiedBy: 'jatin',
    });
  }

  db.update(contentItems)
    .set({
      hook: 'A hook.',
      body: 'A body.',
      caption: 'A caption.',
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

  return id;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('the QA gate (PRD §13)', () => {
  it('passes a complete item into the review queue', () => {
    const id = approvedItem();
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('APPROVED');
  });

  it('routes a blocked item to NEEDS_REVISION, not into review', () => {
    const id = approvedItem();
    // Strip the caption and push it back through the gate.
    act(db, id, 'EDIT', { actor: 'jatin' });
    db.update(contentItems)
      .set({ caption: null, body: null })
      .where(eq(contentItems.id, id))
      .run();
    moveTo(db, id, 'GENERATING');
    moveTo(db, id, 'QA');

    const result = submitForReview(db, id);
    expect(result.ok).toBe(false);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('NEEDS_REVISION');
  });
});

describe('scheduleItem — PRD §22 and §24', () => {
  it('schedules an approved item', () => {
    const id = approvedItem();
    const jobId = scheduleItem(db, {
      contentItemId: id,
      runAt: SLOT,
      actor: 'jatin',
      now: NOW,
    });

    expect(jobId).toBeGreaterThan(0);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('SCHEDULED');
  });

  it('refuses to schedule an item that was never approved', () => {
    const id = approvedItem();
    act(db, id, 'EDIT', { actor: 'jatin' }); // -> NEEDS_REVISION
    expect(() =>
      scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW }),
    ).toThrow();
  });

  it('refuses a time in the past', () => {
    const id = approvedItem();
    expect(() =>
      scheduleItem(db, {
        contentItemId: id,
        runAt: new Date(NOW.getTime() - 60_000),
        now: NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it('is idempotent for the same slot — a double submit makes one job', () => {
    const id = approvedItem();
    const first = scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    const second = scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    expect(second).toBe(first);
    expect(db.select().from(scheduleJobs).all()).toHaveLength(1);
  });

  it('unschedules back to APPROVED without losing approval', () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    unscheduleItem(db, id, { actor: 'jatin', now: NOW });

    const item = db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .get();
    expect(item?.state).toBe('APPROVED');
    expect(item?.scheduledAt).toBeNull();
  });
});

describe('runDueJobs — the manual publisher (decision D1)', () => {
  it('hands the work to a human and records nothing as published', () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    return runDueJobs(db, manualFor, { now: SLOT }).then((report) => {
      expect(report.awaitingHuman).toBe(1);
      expect(report.published).toBe(0);

      // §40: no evidence, so nothing is published.
      expect(db.select().from(publicationRecords).all()).toHaveLength(0);
      expect(
        db.select().from(contentItems).where(eq(contentItems.id, id)).get()
          ?.state,
      ).toBe('PUBLISHING');
      expect(db.select().from(scheduleJobs).all()[0]?.status).toBe(
        'AWAITING_HUMAN',
      );
    });
  });

  it('does not re-run a job that is awaiting confirmation', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, manualFor, { now: SLOT });

    // Running again must not risk a second post.
    const second = await runDueJobs(db, manualFor, {
      now: new Date(SLOT.getTime() + 60_000),
    });
    expect(second.awaitingHuman).toBe(0);
    expect(second.published).toBe(0);
  });

  it('completes on human confirmation', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, manualFor, { now: SLOT });

    confirmManualPublish(db, {
      contentItemId: id,
      externalUrl: 'https://instagram.com/p/abc',
      confirmedBy: 'jatin',
      now: SLOT,
    });

    const item = db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .get();
    expect(item?.state).toBe('PUBLISHED');

    const record = db.select().from(publicationRecords).all()[0];
    expect(record?.confirmedBy).toBe('jatin');
    expect(record?.externalUrl).toBe('https://instagram.com/p/abc');
    expect(db.select().from(scheduleJobs).all()[0]?.status).toBe('SUCCEEDED');
  });

  it('refuses a confirmation with nobody’s name on it', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, manualFor, { now: SLOT });

    expect(() =>
      confirmManualPublish(db, { contentItemId: id, confirmedBy: '  ' }),
    ).toThrow(ScheduleError);
  });
});

describe('PRD §39 — a content item is never published twice', () => {
  it('refuses a second publication record for the same item and platform', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, manualFor, { now: SLOT });
    confirmManualPublish(db, { contentItemId: id, confirmedBy: 'jatin', now: SLOT });

    // The database refuses it whatever the application believes.
    expect(() =>
      confirmManualPublish(db, { contentItemId: id, confirmedBy: 'jatin' }),
    ).toThrow();
    expect(db.select().from(publicationRecords).all()).toHaveLength(1);
  });

  it('only one of two concurrent runners publishes a job', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    const publisher = () =>
      stubPublisher({
        outcome: 'PUBLISHED',
        externalId: 'ext-1',
        externalUrl: 'https://example.com/p/1',
        confirmedBy: null,
        publishedAt: SLOT,
      });

    // Both runners see the job as due at the same instant.
    const [a, b] = await Promise.all([
      runDueJobs(db, publisher, { now: SLOT }),
      runDueJobs(db, publisher, { now: SLOT }),
    ]);

    expect(a.published + b.published).toBe(1);
    expect(db.select().from(publicationRecords).all()).toHaveLength(1);
  });

  it('records the platform’s external id when an API publishes', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    await runDueJobs(
      db,
      () =>
        stubPublisher({
          outcome: 'PUBLISHED',
          externalId: 'ig_123',
          externalUrl: 'https://instagram.com/p/ig_123',
          confirmedBy: null,
          publishedAt: SLOT,
        }),
      { now: SLOT },
    );

    const record = db.select().from(publicationRecords).all()[0];
    expect(record?.externalId).toBe('ig_123');
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('PUBLISHED');
  });
});

describe('PRD §40 — a failed publish is never marked published', () => {
  it('retries a retryable failure with backoff', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    await runDueJobs(
      db,
      () =>
        stubPublisher({
          outcome: 'FAILED',
          error: 'rate limited',
          retryable: true,
        }),
      { now: SLOT },
    );

    const job = db.select().from(scheduleJobs).all()[0];
    expect(job?.status).toBe('PENDING');
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain('rate limited');
    // Backed off rather than hammering a failing platform.
    expect(job?.runAt).toBeGreaterThan(SLOT.getTime());
    expect(db.select().from(publicationRecords).all()).toHaveLength(0);
  });

  it('sends an exhausted job to a human, never to PUBLISHED', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    const failing = () =>
      stubPublisher({ outcome: 'FAILED', error: 'boom', retryable: false });

    await runDueJobs(db, failing, { now: SLOT });

    const item = db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .get();
    expect(item?.state).toBe('NEEDS_REVISION');
    expect(item?.publishedAt).toBeNull();
    expect(db.select().from(scheduleJobs).all()[0]?.status).toBe('FAILED');

    const events = db.select().from(systemEvents).all();
    expect(events.some((e) => e.kind === 'publish.failed')).toBe(true);
  });

  it('never reports PUBLISHED from a publisher that threw', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    await runDueJobs(
      db,
      () => ({
        name: 'throwing',
        kind: 'MANUAL' as const,
        supports: () => true,
        publish: async () => {
          throw new Error('network died mid-request');
        },
      }),
      { now: SLOT },
    );

    expect(db.select().from(publicationRecords).all()).toHaveLength(0);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).not.toBe('PUBLISHED');
  });
});

describe('the MacBook-sleep rule (decision D2)', () => {
  it('marks a long-overdue job MISSED instead of firing it', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    // The Mac woke seven hours later.
    const report = await runDueJobs(db, manualFor, {
      now: new Date(SLOT.getTime() + 7 * 3_600_000),
    });

    expect(report.missed).toBe(1);
    expect(report.awaitingHuman).toBe(0);
    expect(db.select().from(scheduleJobs).all()[0]?.status).toBe('MISSED');
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('SCHEDULED');

    const events = db.select().from(systemEvents).all();
    expect(events.some((e) => e.kind === 'schedule.missed')).toBe(true);
  });

  it('surfaces a missed job for a decision', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, manualFor, {
      now: new Date(SLOT.getTime() + 7 * 3_600_000),
    });

    const attention = jobsNeedingAttention(db);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.status).toBe('MISSED');
    expect(attention[0]?.contentItemId).toBe(id);
  });

  it('can publish a missed job now, by explicit decision', async () => {
    const id = approvedItem();
    const jobId = scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    const late = new Date(SLOT.getTime() + 7 * 3_600_000);
    await runDueJobs(db, manualFor, { now: late });

    resolveMissedJob(db, jobId, 'PUBLISH_NOW', { actor: 'jatin', now: late });

    const report = await runDueJobs(db, manualFor, { now: late });
    expect(report.awaitingHuman).toBe(1);
  });

  it('can cancel a missed job back to APPROVED', async () => {
    const id = approvedItem();
    const jobId = scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    const late = new Date(SLOT.getTime() + 7 * 3_600_000);
    await runDueJobs(db, manualFor, { now: late });

    resolveMissedJob(db, jobId, 'CANCEL', { actor: 'jatin', now: late });

    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('APPROVED');
    expect(db.select().from(scheduleJobs).all()[0]?.status).toBe('CANCELLED');
  });

  it('refuses to resolve a job that was not missed', () => {
    const id = approvedItem();
    const jobId = scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    expect(() => resolveMissedJob(db, jobId, 'CANCEL')).toThrow(ScheduleError);
  });
});

describe('queues', () => {
  it('lists upcoming jobs', () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    expect(upcomingJobs(db)).toHaveLength(1);
  });

  it('records the whole journey in the audit trail', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, actor: 'jatin', now: NOW });
    await runDueJobs(db, manualFor, { now: SLOT });
    confirmManualPublish(db, { contentItemId: id, confirmedBy: 'jatin', now: SLOT });

    const states = historyOf(db, id).map((e) => e.toState);
    expect(states.slice(-4)).toEqual([
      'APPROVED',
      'SCHEDULED',
      'PUBLISHING',
      'PUBLISHED',
    ]);
  });
});

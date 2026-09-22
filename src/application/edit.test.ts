import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { contentItems, scheduleJobs } from '@/db/schema';
import { createPublisherRegistry } from '@/adapters/publishers';
import type { Platform } from '@/domain/content';
import {
  EditRefusedError,
  act,
  editContent,
  historyOf,
  moveTo,
} from './content';
import { submitForReview } from './qa';
import { confirmManualPublish, runDueJobs, scheduleItem } from './schedule';

let sqlite: Database.Database;
let db: DB;

const NOW = new Date('2026-09-22T12:00:00Z');
const SLOT = new Date('2026-09-22T13:00:00Z');

const registry = createPublisherRegistry('MANUAL');
const publisherFor = (p: Platform) => registry.for(p);

/** An item with content filled in, sitting in QA. */
function itemInQa(): number {
  const id = db
    .insert(contentItems)
    .values({
      platform: 'INSTAGRAM',
      format: 'REEL',
      state: 'IDEA',
      hook: 'Original hook.',
      body: 'Original body.',
      caption: 'Original caption.',
      cta: 'Follow.',
      hashtags: 'ai',
      altText: 'Alt.',
    })
    .returning({ id: contentItems.id })
    .get().id;

  moveTo(db, id, 'RESEARCHING');
  moveTo(db, id, 'RESEARCH_VERIFIED');
  moveTo(db, id, 'STRATEGY_READY');
  moveTo(db, id, 'GENERATING');
  moveTo(db, id, 'QA');
  return id;
}

function approvedItem(): number {
  const id = itemInQa();
  submitForReview(db, id);
  act(db, id, 'APPROVE', { actor: 'jatin' });
  return id;
}

function read(id: number) {
  return db.select().from(contentItems).where(eq(contentItems.id, id)).get();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('editContent — the ordinary case', () => {
  it('updates the fields given', () => {
    const id = itemInQa();
    editContent(db, id, { caption: 'A better caption.' }, { actor: 'jatin' });
    expect(read(id)?.caption).toBe('A better caption.');
  });

  it('leaves fields that were not given alone', () => {
    // After a failed parse the point is to fill in what could not be read
    // without losing what could.
    const id = itemInQa();
    editContent(db, id, { caption: 'New.' });
    expect(read(id)?.hook).toBe('Original hook.');
    expect(read(id)?.body).toBe('Original body.');
  });

  it('treats an empty string as clearing the field', () => {
    const id = itemInQa();
    editContent(db, id, { cta: '   ' });
    expect(read(id)?.cta).toBeNull();
  });

  it('does not change state', () => {
    const id = itemInQa();
    const result = editContent(db, id, { caption: 'New.' });
    expect(result.state).toBe('QA');
    expect(result.approvalRevoked).toBe(false);
  });

  it('records the edit in the audit trail', () => {
    const id = itemInQa();
    editContent(db, id, { caption: 'New.' }, { actor: 'jatin' });

    const last = historyOf(db, id).at(-1);
    expect(last?.action).toBe('EDIT');
    expect(last?.note).toContain('caption');
  });

  it('does nothing when given no fields', () => {
    const id = itemInQa();
    const before = historyOf(db, id).length;
    editContent(db, id, {});
    expect(historyOf(db, id).length).toBe(before);
  });

  it('allows editing while awaiting review', () => {
    const id = itemInQa();
    submitForReview(db, id);
    expect(read(id)?.state).toBe('READY_FOR_REVIEW');

    const result = editContent(db, id, { caption: 'Tweaked.' });
    expect(result.approvalRevoked).toBe(false);
    expect(read(id)?.state).toBe('READY_FOR_REVIEW');
  });
});

describe('editContent — editing after approval revokes it (§22)', () => {
  it('sends an approved item back for revision', () => {
    // If content could be edited after approval, the approval would be of
    // nothing in particular.
    const id = approvedItem();
    const result = editContent(db, id, { caption: 'Something else.' }, {
      actor: 'jatin',
    });

    expect(result.approvalRevoked).toBe(true);
    expect(result.state).toBe('NEEDS_REVISION');
    expect(read(id)?.state).toBe('NEEDS_REVISION');
  });

  it('still applies the edit', () => {
    const id = approvedItem();
    editContent(db, id, { caption: 'Something else.' });
    expect(read(id)?.caption).toBe('Something else.');
  });

  it('cancels a pending schedule so nothing unapproved goes out', () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });

    editContent(db, id, { caption: 'Swapped text.' }, { now: NOW });

    expect(db.select().from(scheduleJobs).all()[0]?.status).toBe('CANCELLED');
    expect(read(id)?.scheduledAt).toBeNull();
  });

  it('a scheduled post cannot go out carrying text nobody approved', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    editContent(db, id, { caption: 'Swapped text.' }, { now: NOW });

    const report = await runDueJobs(db, publisherFor, { now: SLOT });
    expect(report.published).toBe(0);
    expect(report.awaitingHuman).toBe(0);
  });

  it('says why in the audit trail', () => {
    const id = approvedItem();
    editContent(db, id, { caption: 'x' }, { actor: 'jatin' });

    const last = historyOf(db, id).at(-1);
    expect(last?.toState).toBe('NEEDS_REVISION');
    expect(last?.note).toContain('approval revoked');
  });

  it('can be re-approved afterwards', () => {
    const id = approvedItem();
    editContent(db, id, { caption: 'Better.' });

    moveTo(db, id, 'GENERATING');
    moveTo(db, id, 'QA');
    submitForReview(db, id);
    expect(read(id)?.state).toBe('READY_FOR_REVIEW');
  });
});

describe('editContent — published content is not rewritable', () => {
  async function publishedItem(): Promise<number> {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, publisherFor, { now: SLOT });
    confirmManualPublish(db, {
      contentItemId: id,
      confirmedBy: 'jatin',
      now: SLOT,
    });
    return id;
  }

  it('refuses to edit a published item', async () => {
    // The record would then disagree with what an audience actually saw, and
    // every analytic attached to it would be about different content.
    const id = await publishedItem();
    expect(() => editContent(db, id, { caption: 'Rewritten.' })).toThrow(
      EditRefusedError,
    );
  });

  it('leaves the content untouched when it refuses', async () => {
    const id = await publishedItem();
    try {
      editContent(db, id, { caption: 'Rewritten.' });
    } catch {
      // expected
    }
    expect(read(id)?.caption).toBe('Original caption.');
  });

  it('refuses while a publish is in flight', async () => {
    const id = approvedItem();
    scheduleItem(db, { contentItemId: id, runAt: SLOT, now: NOW });
    await runDueJobs(db, publisherFor, { now: SLOT });
    expect(read(id)?.state).toBe('PUBLISHING');

    expect(() => editContent(db, id, { caption: 'x' })).toThrow(
      EditRefusedError,
    );
  });

  it('refuses on a rejected item', () => {
    const id = itemInQa();
    submitForReview(db, id);
    act(db, id, 'REJECT', { actor: 'jatin' });
    expect(() => editContent(db, id, { caption: 'x' })).toThrow(
      EditRefusedError,
    );
  });

  it('explains what to do instead', async () => {
    const id = await publishedItem();
    expect(() => editContent(db, id, { caption: 'x' })).toThrow(
      /create a new item/,
    );
  });
});

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import { notifications } from '@/db/schema';
import {
  createInAppNotifier,
  markAllRead,
  markRead,
  recentNotifications,
  unreadCount,
  unreadNotifications,
} from './in-app-notifier';

let sqlite: Database.Database;
let db: DB;
let notifier: ReturnType<typeof createInAppNotifier>;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
  notifier = createInAppNotifier(db);
});

describe('writing notifications', () => {
  it('stores one', () => {
    notifier.notifySync({
      kind: 'CONTENT_READY_FOR_REVIEW',
      title: 'Ready',
      body: 'A reel is ready.',
    });

    const rows = db.select().from(notifications).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Ready');
    expect(rows[0]?.readAt).toBeNull();
  });

  it('assigns severity from the kind, not from the caller', () => {
    notifier.notifySync({ kind: 'PUBLISH_FAILED', title: 'x', body: 'y' });
    notifier.notifySync({ kind: 'SCHEDULED', title: 'a', body: 'b' });

    const rows = db.select().from(notifications).all();
    expect(rows.find((r) => r.kind === 'PUBLISH_FAILED')?.severity).toBe(
      'ERROR',
    );
    expect(rows.find((r) => r.kind === 'SCHEDULED')?.severity).toBe('INFO');
  });

  it('links to a content item when one is given', () => {
    const contentItemId = db
      .insert(schema.contentItems)
      .values({ platform: 'INSTAGRAM', format: 'REEL' })
      .returning({ id: schema.contentItems.id })
      .get().id;

    notifier.notifySync({
      kind: 'CONTENT_READY_FOR_REVIEW',
      title: 'Ready',
      body: 'x',
      contentItemId,
    });

    expect(db.select().from(notifications).all()[0]?.contentItemId).toBe(
      contentItemId,
    );
  });

  it('works through the async Notifier port too', async () => {
    await notifier.notify({ kind: 'SCHEDULED', title: 'x', body: 'y' });
    expect(db.select().from(notifications).all()).toHaveLength(1);
  });
});

describe('deduplication — the thing that keeps the inbox readable', () => {
  it('collapses repeats of the same unresolved thing', () => {
    // A source failing for a week must produce one unread item, not 168.
    for (let i = 0; i < 20; i += 1) {
      notifier.notifySync({
        kind: 'SYSTEM_FAILURE',
        title: 'Feed is down',
        body: `attempt ${i}`,
        dedupeKey: 'source-failing:7',
      });
    }

    expect(db.select().from(notifications).all()).toHaveLength(1);
  });

  it('keeps the latest body when it collapses', () => {
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'Feed is down',
      body: 'first',
      dedupeKey: 'k',
    });
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'Feed is still down',
      body: 'latest',
      dedupeKey: 'k',
    });

    const row = db.select().from(notifications).all()[0];
    expect(row?.title).toBe('Feed is still down');
    expect(row?.body).toBe('latest');
  });

  it('brings a dismissed problem back when it recurs', () => {
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'Down',
      body: 'x',
      dedupeKey: 'k',
    });
    markAllRead(db);
    expect(unreadCount(db)).toBe(0);

    // The problem is still real; a dismissal should not silence it forever.
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'Down again',
      body: 'y',
      dedupeKey: 'k',
    });

    expect(unreadCount(db)).toBe(1);
  });

  it('keeps separate keys separate', () => {
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'A',
      body: 'x',
      dedupeKey: 'source:1',
    });
    notifier.notifySync({
      kind: 'SYSTEM_FAILURE',
      title: 'B',
      body: 'y',
      dedupeKey: 'source:2',
    });

    expect(db.select().from(notifications).all()).toHaveLength(2);
  });

  it('does not collapse notifications with no key', () => {
    // Without a key each is a distinct event, and merging them would lose
    // information the caller deliberately did not ask to merge.
    notifier.notifySync({ kind: 'SCHEDULED', title: 'A', body: 'x' });
    notifier.notifySync({ kind: 'SCHEDULED', title: 'B', body: 'y' });

    expect(db.select().from(notifications).all()).toHaveLength(2);
  });
});

describe('reading and dismissing', () => {
  function seed(count: number): void {
    for (let i = 0; i < count; i += 1) {
      notifier.notifySync({
        kind: 'CONTENT_READY_FOR_REVIEW',
        title: `Item ${i}`,
        body: 'x',
        now: new Date(Date.now() + i * 1000),
      });
    }
  }

  it('counts only unread', () => {
    seed(3);
    expect(unreadCount(db)).toBe(3);
    const first = db.select().from(notifications).all()[0]!;
    markRead(db, first.id);
    expect(unreadCount(db)).toBe(2);
  });

  it('lists unread newest first', () => {
    seed(3);
    const list = unreadNotifications(db);
    expect(list[0]?.title).toBe('Item 2');
  });

  it('dismisses all at once and reports how many', () => {
    seed(4);
    expect(markAllRead(db)).toBe(4);
    expect(unreadCount(db)).toBe(0);
  });

  it('is idempotent — dismissing twice changes nothing', () => {
    seed(1);
    const id = db.select().from(notifications).all()[0]!.id;
    markRead(db, id);
    const readAt = db.select().from(notifications).all()[0]?.readAt;

    markRead(db, id);
    expect(db.select().from(notifications).all()[0]?.readAt).toBe(readAt);
  });

  it('keeps dismissed notifications as history', () => {
    seed(2);
    markAllRead(db);
    // Dismissed is not deleted: what happened is still worth being able to see.
    expect(recentNotifications(db)).toHaveLength(2);
    expect(unreadNotifications(db)).toHaveLength(0);
  });

  it('reports zero on an empty inbox', () => {
    expect(unreadCount(db)).toBe(0);
    expect(unreadNotifications(db)).toEqual([]);
  });
});

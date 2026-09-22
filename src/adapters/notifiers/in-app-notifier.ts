/**
 * In-app notifier — PRD §47, §48.
 *
 * Writes notifications to the database. §48 is explicit that email is a
 * channel for these and never the orchestration mechanism, so the row *is*
 * the notification; a channel may later deliver it. Adding email means adding
 * a second `Notifier` behind the same port, not changing anything here.
 *
 * The property that makes this usable rather than noise: repeated
 * notifications about the same unresolved thing collapse. A source that has
 * been failing for a week should produce one unread item, not a hundred and
 * sixty-eight. Without that, the inbox becomes something to ignore, and an
 * ignored inbox is worse than none — it hides the one thing that mattered.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { notifications } from '@/db/schema';
import type { Notification, NotificationKind, Notifier } from '@/ports';

/** How severe each kind is, so the UI can rank without guessing. */
const SEVERITY: Record<NotificationKind, 'INFO' | 'WARN' | 'ERROR'> = {
  CONTENT_READY_FOR_REVIEW: 'INFO',
  SCHEDULED: 'INFO',
  PUBLISH_FAILED: 'ERROR',
  JOB_MISSED: 'WARN',
  IMPORTANT_RESEARCH: 'INFO',
  UNUSUAL_PERFORMANCE: 'INFO',
  SYSTEM_FAILURE: 'ERROR',
};

export interface AppNotification extends Notification {
  /**
   * Collapses repeats of the same unresolved thing. Two notifications with
   * the same key are the same notification; the second refreshes the first
   * rather than adding to the pile.
   */
  readonly dedupeKey?: string;
  readonly now?: Date;
}

export interface DbNotifier extends Notifier {
  notify(notification: AppNotification): Promise<void>;
  /** Synchronous variant, for callers already inside a transaction. */
  notifySync(notification: AppNotification): void;
}

export function createInAppNotifier(db: DB): DbNotifier {
  function write(notification: AppNotification): void {
    const now = (notification.now ?? new Date()).getTime();
    const severity = SEVERITY[notification.kind];

    if (notification.dedupeKey) {
      const existing = db
        .select({ id: notifications.id, readAt: notifications.readAt })
        .from(notifications)
        .where(eq(notifications.dedupeKey, notification.dedupeKey))
        .get();

      if (existing) {
        // Refresh it and mark it unread again — the thing is still true, and
        // a previously-dismissed problem that recurs deserves attention.
        db.update(notifications)
          .set({
            title: notification.title,
            body: notification.body,
            severity,
            readAt: null,
            createdAt: now,
          })
          .where(eq(notifications.id, existing.id))
          .run();
        return;
      }
    }

    db.insert(notifications)
      .values({
        kind: notification.kind,
        severity,
        title: notification.title,
        body: notification.body,
        contentItemId: notification.contentItemId ?? null,
        dedupeKey: notification.dedupeKey ?? null,
        createdAt: now,
      })
      .run();
  }

  return {
    name: 'in-app',
    notifySync: write,
    async notify(notification) {
      write(notification);
    },
  };
}

export function unreadNotifications(db: DB, limit = 50) {
  return db
    .select()
    .from(notifications)
    .where(isNull(notifications.readAt))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

export function unreadCount(db: DB): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(isNull(notifications.readAt))
    .get();
  return row?.n ?? 0;
}

export function recentNotifications(db: DB, limit = 50) {
  return db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

export function markRead(db: DB, id: number, now: Date = new Date()): void {
  db.update(notifications)
    .set({ readAt: now.getTime() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .run();
}

export function markAllRead(db: DB, now: Date = new Date()): number {
  const result = db
    .update(notifications)
    .set({ readAt: now.getTime() })
    .where(isNull(notifications.readAt))
    .run();
  return result.changes;
}

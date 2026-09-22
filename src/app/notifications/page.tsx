import { getDb } from '@/db/runtime';
import { recentNotifications } from '@/adapters/notifiers/in-app-notifier';
import { DismissAllButton, DismissButton } from './controls';

export const dynamic = 'force-dynamic';

function when(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The inbox — PRD §47.
 *
 * Unread first, because the only question this page answers is "what still
 * needs me". Everything else is history, and history belongs below the fold.
 */
export default async function NotificationsPage() {
  const db = getDb();
  const all = recentNotifications(db);
  const unread = all.filter((n) => n.readAt === null);
  const read = all.filter((n) => n.readAt !== null);

  return (
    <main>
      <div className="panel-head">
        <h1>Notifications</h1>
        {unread.length > 0 && <DismissAllButton />}
      </div>
      <p className="muted">
        {unread.length === 0
          ? 'Nothing needs you.'
          : `${unread.length} unread`}
      </p>

      {unread.length > 0 && (
        <section className="panel">
          {unread.map((item) => (
            <article className="notification" key={item.id}>
              <div className="item-head">
                <span>
                  <span className={`tag tag-sev-${item.severity}`}>
                    {item.severity}
                  </span>{' '}
                  <strong>{item.title}</strong>
                </span>
                <span className="muted small">{when(item.createdAt)}</span>
              </div>
              <p className="summary">{item.body}</p>
              <div className="form-row">
                {item.contentItemId && (
                  <a className="small" href={`/content/${item.contentItemId}`}>
                    Open the item
                  </a>
                )}
                <DismissButton id={item.id} />
              </div>
            </article>
          ))}
        </section>
      )}

      {read.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Earlier</h2>
          {read.slice(0, 20).map((item) => (
            <div className="row" key={item.id}>
              <span className="muted">{item.title}</span>
              <span className="muted small">{when(item.createdAt)}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

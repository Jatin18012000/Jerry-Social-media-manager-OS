import { getDb } from '@/db/runtime';
import { unreadCount } from '@/adapters/notifiers/in-app-notifier';

import { SignOutLink } from './sign-out';

/**
 * The unread badge is the only reason this is a server component — the count
 * has to be read per request, and §47's point is that you should not have to
 * go looking to find out something needs you.
 */
export async function Nav() {
  let unread = 0;
  try {
    unread = unreadCount(getDb());
  } catch {
    // The nav renders on the login page too, where the database may not be
    // reachable yet. A missing badge is better than a broken page.
  }

  return (
    <nav className="top">
      <a href="/">Overview</a>
      <a href="/research">Research</a>
      <a href="/opportunities">Opportunities</a>
      <a href="/review">Review</a>
      <a href="/schedule">Schedule</a>
      <a href="/analytics">Analytics</a>
      <a href="/notifications">
        Inbox
        {unread > 0 && <span className="nav-count">{unread}</span>}
      </a>
      <a href="/system">System</a>
      <a href="/settings/brand">Brand</a>
      <SignOutLink />
    </nav>
  );
}

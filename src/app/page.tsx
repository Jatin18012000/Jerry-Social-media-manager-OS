import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import {
  contentItems,
  researchItems,
  scheduleJobs,
  sources,
  systemEvents,
} from '@/db/schema';
import { getDb } from '@/db/runtime';
import { awaitingMetrics, latestPerformance } from '@/application/analytics';
import { itemsRestingOnUnverifiedClaims } from '@/application/content';
import { presentableFindings } from '@/application/learning';
import { activeBrand } from '@/application/opportunities';
import { jobsNeedingAttention, upcomingJobs } from '@/application/schedule';

export const dynamic = 'force-dynamic';

function when(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(ms));
}

/**
 * Overview — PRD §45.
 *
 * Ordered by what is actually blocked on a person, not by what is most
 * impressive to look at. Anything needing a decision comes first; the numbers
 * come last, because they are information rather than work.
 */
export default async function Dashboard() {
  const db = getDb();
  const dayAgo = Date.now() - 86_400_000;

  const pendingReview = db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(inArray(contentItems.state, ['READY_FOR_REVIEW', 'QA']))
    .all();

  const awaitingConfirm = db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(eq(contentItems.state, 'PUBLISHING'))
    .all();

  const attention = jobsNeedingAttention(db);
  const upcoming = upcomingJobs(db);
  const pendingMetrics = awaitingMetrics(db);
  const unverified = itemsRestingOnUnverifiedClaims(db);

  const newResearch = db
    .select({ id: researchItems.id })
    .from(researchItems)
    .where(
      and(
        eq(researchItems.status, 'NEW'),
        gte(researchItems.discoveredAt, dayAgo),
      ),
    )
    .all();

  const performance = latestPerformance(db, 5);
  const findings = presentableFindings(db, 3);
  const brand = activeBrand(db);

  const failingSources = db.select().from(sources).all().filter((s) => s.lastError);

  const recentErrors = db
    .select()
    .from(systemEvents)
    .where(
      and(
        inArray(systemEvents.severity, ['ERROR', 'WARN']),
        gte(systemEvents.createdAt, dayAgo),
      ),
    )
    .orderBy(desc(systemEvents.createdAt))
    .limit(5)
    .all();

  const scheduled = db
    .select({ id: scheduleJobs.id })
    .from(scheduleJobs)
    .where(eq(scheduleJobs.status, 'PENDING'))
    .all();

  const needsYou =
    pendingReview.length +
    awaitingConfirm.length +
    attention.length +
    pendingMetrics.length;

  return (
    <main>
      <h1>Overview</h1>
      <p className="muted">
        {needsYou === 0
          ? 'Nothing is waiting on you.'
          : `${needsYou} thing(s) waiting on you.`}
      </p>

      {brand.isPlaceholder && (
        <section className="panel">
          <p className="warn">
            <strong>Brand voice is not configured.</strong> Every brief is
            being written to a generic placeholder, which is exactly the
            failure §57 calls Risk 1. This needs the real positioning, voice
            and examples before output quality means anything.
          </p>
        </section>
      )}

      {needsYou > 0 && (
        <section className="panel">
          <h2 className="panel-title">Waiting on you</h2>

          {pendingReview.length > 0 && (
            <div className="row">
              <a href="/review">Content to review</a>
              <span className="tag">{pendingReview.length}</span>
            </div>
          )}
          {awaitingConfirm.length > 0 && (
            <div className="row">
              <a href="/review">Posted yet? — confirm to record</a>
              <span className="tag">{awaitingConfirm.length}</span>
            </div>
          )}
          {attention.length > 0 && (
            <div className="row">
              <a href="/schedule">Schedule needs a decision</a>
              <span className="tag">{attention.length}</span>
            </div>
          )}
          {pendingMetrics.length > 0 && (
            <div className="row">
              <a href="/analytics">Metrics to capture</a>
              <span className="tag">{pendingMetrics.length}</span>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Pipeline</h2>
        <div className="row">
          <a href="/research">New research (24h)</a>
          <span className="tag">{newResearch.length}</span>
        </div>
        <div className="row">
          <a href="/schedule">Scheduled</a>
          <span className="tag">{scheduled.length}</span>
        </div>
        {upcoming[0] && (
          <div className="row">
            <span className="muted">Next out</span>
            <span className="muted small">{when(upcoming[0].runAt)}</span>
          </div>
        )}
        {unverified.length > 0 && (
          <div className="row">
            <span className="error">
              Content resting on unverified claims (§16)
            </span>
            <span className="tag">{unverified.length}</span>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">What we have learned</h2>
        {findings.length === 0 ? (
          <p className="muted small">
            Nothing yet. Findings appear once enough posts have been measured
            — §29 forbids drawing conclusions from a handful of posts, so this
            stays empty for a while by design.
          </p>
        ) : (
          findings.map((finding) => (
            <div className="finding" key={finding.id}>
              <span className={`tag tag-${finding.status}`}>
                {finding.status}
              </span>
              <span>{finding.summary}</span>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Recent performance</h2>
        {performance.length === 0 ? (
          <p className="muted small">Nothing measured yet.</p>
        ) : (
          performance.map((row) => (
            <div className="row" key={row.contentItemId}>
              <a href={`/content/${row.contentItemId}`}>
                {row.platform} · {row.format}
              </a>
              <span className="muted small">
                {row.followsPerThousand === null
                  ? '— follows/1k'
                  : `${row.followsPerThousand.toFixed(2)} follows/1k`}
              </span>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">System</h2>
        {failingSources.length === 0 && recentErrors.length === 0 && (
          <p className="muted small">No failures in the last 24 hours.</p>
        )}
        {failingSources.map((source) => (
          <div className="row" key={source.id}>
            <span className="error small">{source.name} is failing</span>
            <span className="muted small">{source.lastError?.slice(0, 40)}</span>
          </div>
        ))}
        {recentErrors.map((event) => (
          <div className="row" key={event.id}>
            <span
              className={event.severity === 'ERROR' ? 'error small' : 'warn small'}
            >
              {event.kind}
            </span>
            <span className="muted small">{when(event.createdAt)}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

import { getDb } from '@/db/runtime';
import { jobsNeedingAttention, upcomingJobs } from '@/application/schedule';
import { MissedJobForm, RunSchedulerButton, UnscheduleButton } from './controls';

export const dynamic = 'force-dynamic';

function when(ms: number, timezone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(ms));
}

/**
 * The schedule — PRD §24, §45, decision D2.
 *
 * "Needs attention" comes first because it is the only part that is actually
 * blocked on a person. A missed window is the expected consequence of running
 * on a laptop that sleeps, so it is presented as a routine decision rather
 * than an error.
 */
export default async function SchedulePage() {
  const db = getDb();
  const attention = jobsNeedingAttention(db);
  const upcoming = upcomingJobs(db);

  return (
    <main>
      <div className="panel-head">
        <h1>Schedule</h1>
        <RunSchedulerButton />
      </div>

      {attention.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Needs a decision</h2>
          {attention.map((job) => (
            <article className="item" key={job.id}>
              <div className="item-head">
                <span>
                  <strong>
                    {job.platform} · {job.format}
                  </strong>{' '}
                  <span className="tag">{job.status}</span>
                </span>
                <a className="small" href={`/content/${job.contentItemId}`}>
                  Open
                </a>
              </div>

              <p className="muted small">
                Was due {when(job.runAt)}
                {job.lastError ? ` · ${job.lastError}` : ''}
              </p>

              {job.caption && (
                <p className="summary">{job.caption.slice(0, 160)}</p>
              )}

              {job.status === 'MISSED' && (
                <>
                  <p className="muted small">
                    The machine was asleep when this was due. Publishing it
                    now is a choice, not a default (§24).
                  </p>
                  <MissedJobForm
                    jobId={job.id}
                    contentItemId={job.contentItemId}
                  />
                </>
              )}

              {job.status === 'AWAITING_HUMAN' && (
                <p className="muted small">
                  Handed to you to post. Confirm it on the{' '}
                  <a href="/review">review screen</a> once it is live.
                </p>
              )}

              {job.status === 'FAILED' && (
                <p className="error small">
                  Publishing failed and the item was sent back for revision.
                  Nothing was marked published (§40).
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Upcoming</h2>
        {upcoming.length === 0 && (
          <p className="muted">
            Nothing scheduled. Approve something on the{' '}
            <a href="/review">review screen</a> first — §22 allows scheduling
            only after approval.
          </p>
        )}
        {upcoming.map((job) => (
          <div className="row" key={job.id}>
            <span>
              <a href={`/content/${job.contentItemId}`}>
                {job.platform} · {job.format}
              </a>{' '}
              <span className="muted small">{when(job.runAt, job.timezone)}</span>
            </span>
            <UnscheduleButton contentItemId={job.contentItemId} />
          </div>
        ))}
      </section>
    </main>
  );
}

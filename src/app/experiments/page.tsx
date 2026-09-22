import { experimentsShelved, loadEnv } from '@/config/env';
import { METRICS } from '@/application/learning';
import { listExperiments } from '@/application/experiments';
import { getDb } from '@/db/runtime';

import { NewExperimentForm } from './controls';

export const dynamic = 'force-dynamic';

const METRIC_OPTIONS = Object.entries(METRICS).map(([value, label]) => ({
  value,
  label,
}));

function when(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Experiments — PRD §30.
 *
 * §29 caps observational analysis at HYPOTHESIS: a pattern in posts you
 * happened to publish is not a cause. This screen is the only route past
 * that, and it works by fixing the claim before the data exists.
 */
export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ hypothesis?: string }>;
}) {
  const db = getDb();
  const params = await searchParams;
  const shelved = experimentsShelved(loadEnv());
  const all = listExperiments(db);

  const running = all.filter((e) => e.status === 'RUNNING');
  const drafts = all.filter((e) => e.status === 'DRAFT');
  const done = all.filter(
    (e) => e.status === 'CONCLUDED' || e.status === 'ABANDONED',
  );

  return (
    <main>
      <h1>Experiments</h1>
      <p className="muted">
        {running.length} running · {drafts.length} draft ·{' '}
        {done.length} finished
      </p>

      {shelved ? (
        <section className="panel">
          <h2 className="panel-title">Parked for the launch phase</h2>
          <p className="muted small">
            Experiments are shelved by product decision. The first content
            cycle runs <strong>observe → measure → learn → hypothesise</strong>
            {' '}rather than requiring controlled tests: at the current
            posting cadence a single two-armed experiment costs ten posts, and
            that is a price worth paying only once there is enough volume for
            the answer to arrive while it still matters.
          </p>
          <p className="muted small">
            Nothing has been deleted. The infrastructure is intact and tested,
            and setting <code>EXPERIMENTS_MODE=ACTIVE</code> restores it.
          </p>
          <p className="muted small">
            <strong>What has not changed:</strong> §29&rsquo;s ceiling.
            Observational findings still stop at HYPOTHESIS, and SUPPORTED is
            still reachable only through a completed pre-registered
            experiment. Shelving removes the ability to run one; it does not
            lower the bar for concluding without one.
          </p>
        </section>
      ) : (
        <section className="panel">
          <p className="muted small">
            Observational analysis can notice a pattern; it cannot establish a
            cause. §30 is the only route to a SUPPORTED finding, and it works
            by fixing the hypothesis, the metric, the two arms and the minimum
            sample size <em>before</em> the posts go out. After that there is
            no edit path and no early conclusion.
          </p>
          <NewExperimentForm
            metrics={METRIC_OPTIONS}
            defaultHypothesis={params.hypothesis}
          />
        </section>
      )}

      {all.length === 0 && !shelved && (
        <section className="panel">
          <p className="muted">
            No experiments yet. The usual starting point is a HYPOTHESIS
            finding on the Analytics page — something the data hints at
            strongly enough to be worth testing deliberately.
          </p>
        </section>
      )}

      {[
        { title: 'Running', rows: running },
        { title: 'Drafts', rows: drafts },
        { title: 'Finished', rows: done },
      ]
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section className="panel" key={group.title}>
            <h2 className="panel-title">{group.title}</h2>
            {group.rows.map((experiment) => (
              <div className="item" key={experiment.id}>
                <div className="item-head">
                  <span>
                    <a href={`/experiments/${experiment.id}`}>
                      <strong>{experiment.hypothesis}</strong>
                    </a>
                  </span>
                  <span className="muted small">
                    {experiment.verdict ? (
                      <span className={`tag tag-${experiment.verdict}`}>
                        {experiment.verdict}
                      </span>
                    ) : (
                      <span className="tag">{experiment.status}</span>
                    )}
                  </span>
                </div>
                <p className="muted small">
                  {experiment.metric} · {experiment.controlName}{' '}
                  {experiment.controlCount}/{experiment.minSampleSize} vs{' '}
                  {experiment.treatmentName} {experiment.treatmentCount}/
                  {experiment.minSampleSize}
                  {experiment.pending > 0 && ` · ${experiment.pending} pending`}
                  {experiment.startAt !== null &&
                    ` · started ${when(experiment.startAt)}`}
                </p>
                {experiment.blocker && (
                  <p className="warn small">{experiment.blocker}</p>
                )}
                {experiment.result && (
                  <p className="muted small">{experiment.result}</p>
                )}
              </div>
            ))}
          </section>
        ))}
    </main>
  );
}

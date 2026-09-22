import { notFound } from 'next/navigation';

import {
  ExperimentError,
  assignableItems,
  experimentDetail,
} from '@/application/experiments';
import { METRICS, type MetricName } from '@/application/learning';
import { getDb } from '@/db/runtime';

import {
  AbandonForm,
  AssignForm,
  ConcludeButton,
  StartButton,
  UnassignButton,
} from '../controls';

export const dynamic = 'force-dynamic';

/** Null, never 0 — an unmeasured post has no value (§40). */
function value(v: number | null): string {
  return v === null ? '—' : v.toFixed(2);
}

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id)) notFound();

  const db = getDb();

  let experiment;
  try {
    experiment = experimentDetail(db, id);
  } catch (error) {
    if (error instanceof ExperimentError) notFound();
    throw error;
  }

  const metricLabel =
    METRICS[experiment.metric as MetricName] ?? experiment.metric;

  const arms = experiment.arms
    ? [experiment.arms.control.name, experiment.arms.treatment.name]
    : [];

  const candidates =
    experiment.status === 'RUNNING' ? assignableItems(db, id) : [];

  const byArm = (name: string) =>
    experiment.assignments.filter(
      (a) => a.variant.toLowerCase() === name.toLowerCase(),
    );

  return (
    <main>
      <p className="muted small">
        <a href="/experiments">← Experiments</a>
      </p>

      <h1>{experiment.hypothesis}</h1>
      <p className="muted">
        {experiment.verdict ? (
          <span className={`tag tag-${experiment.verdict}`}>
            {experiment.verdict}
          </span>
        ) : (
          <span className="tag">{experiment.status}</span>
        )}{' '}
        measuring {metricLabel}
      </p>

      <section className="panel">
        <h2 className="panel-title">Pre-registered terms</h2>
        <p className="muted small">
          {experiment.status === 'DRAFT'
            ? 'Not yet fixed. Starting the experiment freezes all of this.'
            : 'Fixed when the experiment started. There is no edit path — ' +
              'that is what makes the result a test rather than an ' +
              'interpretation.'}
        </p>

        {experiment.arms === null ? (
          <p className="error small">
            The stored arm definition cannot be read, so this experiment
            cannot be concluded on any terms. It is kept visible rather than
            hidden.
          </p>
        ) : (
          <>
            <div className="row">
              <span>
                <strong>Control</strong> · {experiment.arms.control.name}
              </span>
              <span className="muted small">
                {experiment.arms.control.description}
              </span>
            </div>
            <div className="row">
              <span>
                <strong>Treatment</strong> · {experiment.arms.treatment.name}
              </span>
              <span className="muted small">
                {experiment.arms.treatment.description}
              </span>
            </div>
          </>
        )}

        <div className="row">
          <span className="muted">Minimum per arm</span>
          <span>{experiment.minSampleSize}</span>
        </div>
      </section>

      {experiment.status === 'DRAFT' && (
        <section className="panel">
          <h2 className="panel-title">Start</h2>
          <p className="muted small">
            Nothing may be assigned until the experiment is running, because
            data that exists before the terms are fixed is not a
            pre-registered test.
          </p>
          <StartButton experimentId={id} />
          <AbandonForm experimentId={id} />
        </section>
      )}

      {experiment.status === 'RUNNING' && (
        <section className="panel">
          <h2 className="panel-title">Assign posts</h2>
          <p className="muted small">
            Assign before publishing. An item that has already been measured
            cannot join — its result is known, so enrolling it would mean
            choosing a data point by its outcome.
          </p>
          <AssignForm experimentId={id} arms={arms} items={candidates} />
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Arms</h2>
        {experiment.assignments.length === 0 && (
          <p className="muted">Nothing assigned yet.</p>
        )}

        {arms.map((arm) => (
          <div key={arm}>
            <p>
              <strong>{arm}</strong>{' '}
              <span className="muted small">
                {byArm(arm).length} assigned
              </span>
            </p>
            {byArm(arm).map((assignment) => (
              <div className="row" key={assignment.contentItemId}>
                <span>
                  <a href={`/content/${assignment.contentItemId}`}>
                    #{assignment.contentItemId} {assignment.topic ?? 'Untitled'}
                  </a>{' '}
                  <span className="muted small">
                    {assignment.platform} · {assignment.state}
                  </span>
                </span>
                <span className="muted small">
                  {value(assignment.value)}
                  {experiment.status === 'RUNNING' &&
                    assignment.value === null && (
                      <>
                        {' '}
                        <UnassignButton
                          experimentId={id}
                          contentItemId={assignment.contentItemId}
                        />
                      </>
                    )}
                </span>
              </div>
            ))}
          </div>
        ))}

        {experiment.pending > 0 && (
          <p className="muted small">
            {experiment.pending} assigned post(s) are not measurable yet —
            unpublished, or published with no metric reported. They do not
            count toward the minimum, and they are not counted as zero (§40).
          </p>
        )}
      </section>

      {experiment.status === 'RUNNING' && (
        <section className="panel">
          <h2 className="panel-title">Conclude</h2>
          <p className="muted small">
            Only once both arms reach {experiment.minSampleSize}. Concluding
            the moment the numbers look right is optional stopping, and it
            manufactures significance out of noise.
          </p>
          <ConcludeButton experimentId={id} blocker={experiment.blocker} />
          <AbandonForm experimentId={id} />
        </section>
      )}

      {(experiment.status === 'CONCLUDED' ||
        experiment.status === 'ABANDONED') && (
        <section className="panel">
          <h2 className="panel-title">Result</h2>
          <p>{experiment.result ?? 'No result recorded.'}</p>
          {experiment.confidence && (
            <p className="muted small">Confidence {experiment.confidence}.</p>
          )}
          {experiment.verdict === 'SUPPORTED' && (
            <p className="muted small">
              Recorded as a SUPPORTED finding on the Analytics page — the only
              status observational analysis can never reach.
            </p>
          )}
          {(experiment.verdict === 'REFUTED' ||
            experiment.verdict === 'INCONCLUSIVE') && (
            <p className="muted small">
              No finding was earned. The result is kept here, where the terms
              that produced it are visible, rather than promoted into
              something the system believes.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

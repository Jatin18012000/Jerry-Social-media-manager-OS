import { getDb } from '@/db/runtime';
import { awaitingMetrics, latestPerformance } from '@/application/analytics';
import { gaps, presentableFindings } from '@/application/learning';
import { CaptureForm, RecomputeButton } from './controls';

export const dynamic = 'force-dynamic';

function n(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-IN');
}

/**
 * Analytics — PRD §26, §27, §45, decision D4.
 *
 * Every "—" on this page means "not reported", never zero. §40 forbids
 * fabricating a metric, and showing 0 for a number nobody captured would be
 * exactly that — it would read as a real result rather than a gap.
 */
export default async function AnalyticsPage() {
  const db = getDb();
  const performance = latestPerformance(db);
  const pending = awaitingMetrics(db);
  const findings = presentableFindings(db);
  const insufficient = gaps(db);

  return (
    <main>
      <h1>Analytics</h1>
      <p className="muted">
        {performance.length} item(s) measured
        {pending.length > 0 && ` · ${pending.length} awaiting capture`}
      </p>

      {pending.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Capture metrics</h2>
          <p className="muted small">
            Open the post&rsquo;s Insights, screenshot it, then select the text
            in Preview (macOS Live Text) and paste it here. Nothing leaves this
            machine.
          </p>
          {pending.map((item) => (
            <CaptureForm
              key={item.id}
              contentItemId={item.id}
              platform={item.platform}
              format={item.format}
              caption={item.caption}
              externalUrl={item.externalUrl}
            />
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What we have learned</h2>
          <RecomputeButton />
        </div>
        <p className="muted small">
          §29 draws a hard line between an observation and a conclusion. A
          finding below the minimum sample size is never shown as either — it
          is listed as a gap instead. Only a pre-registered experiment (§30)
          can ever reach SUPPORTED; observational data stops at HYPOTHESIS.
        </p>

        {findings.length === 0 && (
          <p className="muted">
            Nothing stands up yet. That is the expected state until enough
            posts have been measured.
          </p>
        )}

        {findings.map((finding) => (
          <div className="finding" key={finding.id}>
            <span className={`tag tag-${finding.status}`}>{finding.status}</span>
            <span>
              {finding.summary}{' '}
              <span className="muted small">
                (n={finding.sampleSize}, confidence {finding.confidence})
              </span>
              {/*
                A HYPOTHESIS is where observational analysis stops (§29). This
                link is the only way past it: it carries the wording into a
                pre-registration, which is what §30 requires before the
                finding could ever read as a cause.
              */}
              {finding.status === 'HYPOTHESIS' && (
                <>
                  {' '}
                  <a
                    href={`/experiments?hypothesis=${encodeURIComponent(
                      finding.summary,
                    )}`}
                  >
                    Test this deliberately →
                  </a>
                </>
              )}
              {finding.status === 'SUPPORTED' && finding.experimentId !== null && (
                <>
                  {' '}
                  <a href={`/experiments/${finding.experimentId}`}>
                    See the experiment →
                  </a>
                </>
              )}
            </span>
          </div>
        ))}

        {insufficient.length > 0 && (
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            {insufficient.length} segment(s) have too little data to say
            anything about yet:{' '}
            {insufficient
              .slice(0, 8)
              .map((f) => `${f.segment} (n=${f.sampleSize})`)
              .join(', ')}
            .
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Performance</h2>
        <p className="muted small">
          Sorted by the §27 north star — follows per 1,000 impressions — which
          separates content that reached people from content that converted
          them. &ldquo;—&rdquo; means not reported, not zero.
        </p>

        {performance.length === 0 && (
          <p className="muted">
            Nothing measured yet. Publish something, then capture its metrics.
          </p>
        )}

        {performance.length > 0 && (
          <div className="table-scroll">
            <table className="metrics">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Reach</th>
                  <th>Likes</th>
                  <th>Saves</th>
                  <th>Shares</th>
                  <th>Follows</th>
                  <th>Eng %</th>
                  <th>F/1k</th>
                </tr>
              </thead>
              <tbody>
                {[...performance]
                  .sort(
                    (a, b) =>
                      (b.followsPerThousand ?? -1) -
                      (a.followsPerThousand ?? -1),
                  )
                  .map((row) => (
                    <tr key={row.contentItemId}>
                      <td>
                        <a href={`/content/${row.contentItemId}`}>
                          {row.platform} {row.format}
                        </a>
                        <span className="muted small"> {row.language}</span>
                      </td>
                      <td>{n(row.reach ?? row.impressions)}</td>
                      <td>{n(row.likes)}</td>
                      <td>{n(row.saves)}</td>
                      <td>{n(row.shares)}</td>
                      <td>{n(row.follows)}</td>
                      <td>
                        {row.engagementRatePct === null
                          ? '—'
                          : `${row.engagementRatePct.toFixed(1)}`}
                      </td>
                      <td>
                        <strong>
                          {row.followsPerThousand === null
                            ? '—'
                            : row.followsPerThousand.toFixed(2)}
                        </strong>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

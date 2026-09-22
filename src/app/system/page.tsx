import { vaultFromEnv } from '@/adapters/obsidian/vault-writer';
import { findOrphans } from '@/application/obsidian-export';
import { getDb } from '@/db/runtime';
import {
  agentUsage,
  costSummary,
  generationUsage,
  integrations,
  recentAgentFailures,
  recentFailures,
  sourceHealth,
} from '@/application/system';
import { ObsidianExportButton } from './controls';

export const dynamic = 'force-dynamic';

function when(ms: number | null): string {
  if (ms === null) return 'never';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * System — PRD §43, §44, §45.
 *
 * Answers questions that are otherwise matters of belief: is the local model
 * actually doing anything, is something quietly failing, what has this cost,
 * which adapter is behind each port.
 */
export default async function SystemPage() {
  const db = getDb();

  const adapters = integrations();
  const agents = agentUsage(db);
  const agentFailures = recentAgentFailures(db);
  const cost = costSummary(db);
  const failures = recentFailures(db);
  const generation = generationUsage(db);
  const feeds = sourceHealth(db);

  const failing = feeds.filter((s) => s.lastError !== null);
  const vault = vaultFromEnv();

  // Computed on load rather than only after an export, so a vault that has
  // drifted says so without needing to be exported to first.
  const orphans = vault ? await findOrphans(db, vault) : [];

  return (
    <main>
      <h1>System</h1>
      <p className="muted">
        {failing.length === 0 && failures.length === 0
          ? 'Nothing failing.'
          : `${failing.length} source(s) failing · ${failures.length} warning(s) in the last 7 days`}
      </p>

      <section className="panel">
        <h2 className="panel-title">Integrations</h2>
        {adapters.map((adapter) => (
          <div className="item" key={adapter.name}>
            <div className="item-head">
              <span>
                <strong>{adapter.name}</strong>{' '}
                <span className="tag">{adapter.mode}</span>
              </span>
              <span className="muted small">
                {adapter.live ? 'live' : 'local / manual'}
              </span>
            </div>
            <p className="muted small">{adapter.note}</p>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">AI usage</h2>
        <p className="muted small">
          Which worker is actually doing the classification. If the local model
          is configured but everything shows as heuristic, it is not answering.
        </p>

        {agents.length === 0 && (
          <p className="muted">Nothing has run in the last 30 days.</p>
        )}

        {agents.length > 0 && (
          <div className="table-scroll">
            <table className="metrics">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Model</th>
                  <th>Runs</th>
                  <th>Failed</th>
                  <th>Avg ms</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={`${agent.agent}-${agent.model ?? 'none'}`}>
                    <td>{agent.agent}</td>
                    <td className="muted">{agent.model ?? '—'}</td>
                    <td>{agent.runs}</td>
                    <td className={agent.failures > 0 ? 'warn' : ''}>
                      {agent.failures}
                    </td>
                    <td>
                      {agent.avgDurationMs === null
                        ? '—'
                        : Math.round(agent.avgDurationMs)}
                    </td>
                    <td className="muted">{when(agent.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {agentFailures.length > 0 && (
          <>
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Recent model failures:
            </p>
            {agentFailures.map((run) => (
              <div className="row" key={run.id}>
                <span className="warn small">
                  {run.agent} · {run.status}
                </span>
                <span className="muted small">
                  {run.error?.slice(0, 60) ?? '—'}
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      {generation.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Generation</h2>
          {generation.map((row) => (
            <div className="row" key={`${row.mode}-${row.provider ?? 'none'}`}>
              <span>
                {row.mode}
                {row.provider ? ` · ${row.provider}` : ''}
              </span>
              <span className="muted small">
                {row.runs} pasted, {row.parsedOk} parsed cleanly
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Cost</h2>
        <div className="row">
          <span>Last {cost.windowDays} days</span>
          <span>
            <strong>
              {cost.total === 0
                ? '0'
                : `${cost.total.toFixed(2)} ${cost.currency}`}
            </strong>
          </span>
        </div>
        <div className="row">
          <span className="muted">Per content item</span>
          <span className="muted">
            {cost.perContentItem === null
              ? '—'
              : cost.perContentItem.toFixed(4)}
          </span>
        </div>
        {cost.records === 0 && (
          <p className="muted small">
            Nothing recorded, which is expected: generation is manual and
            classification runs locally, so there is no metered spend (§32).
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Sources</h2>
        {feeds.map((source) => (
          <div className="row" key={source.id}>
            <span>
              {source.name} <span className="tag">{source.credibilityTier}</span>
            </span>
            <span className={source.lastError ? 'error small' : 'muted small'}>
              {source.lastError
                ? source.lastError.slice(0, 40)
                : `polled ${when(source.lastPolledAt)}`}
            </span>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">Obsidian</h2>
        <p className="muted small">
          A one-way, human-readable projection of research, opportunities and
          published posts. There is no importer — the database stays the system
          of record because the vault cannot speak back. Anything you write
          below the generated marker in a note survives a re-export.
        </p>
        {vault ? (
          <>
            <div className="row">
              <span className="muted">Vault</span>
              <span className="muted small">{vault.root}</span>
            </div>
            <ObsidianExportButton />

            {orphans.length > 0 && (
              <>
                <p className="warn small" style={{ marginTop: '0.75rem' }}>
                  {orphans.length} note(s) no longer have a row behind them.
                  Nothing has been deleted — a projection that reached back
                  into your vault could destroy a note you had rewritten, so
                  removing these is your call.
                </p>
                {orphans.slice(0, 20).map((orphan) => (
                  <div className="row" key={orphan.path}>
                    <span className="muted small">{orphan.path}</span>
                    <span className="muted small">{orphan.folder} #{orphan.id}</span>
                  </div>
                ))}
                {orphans.length > 20 && (
                  <p className="muted small">
                    …and {orphans.length - 20} more.
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <p className="muted small">
            Not configured. Set <code>OBSIDIAN_VAULT_PATH</code> in{' '}
            <code>.env.local</code> and restart. Unset is a supported
            configuration, not a missing step.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Failures (7 days)</h2>
        {failures.length === 0 && <p className="muted">None.</p>}
        {failures.map((event) => (
          <div className="row" key={event.id}>
            <span
              className={
                event.severity === 'ERROR' ? 'error small' : 'warn small'
              }
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

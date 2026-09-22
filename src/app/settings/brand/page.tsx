import { getDb } from '@/db/runtime';
import { activeBrandProvenance, brandVersions } from '@/application/brand';
import { activeBrand } from '@/application/opportunities';

import { ActivateForm, BrandForm } from './controls';

export const dynamic = 'force-dynamic';

function when(ms: number | null): string {
  if (ms === null) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(ms));
}

/**
 * Brand configuration — PRD §8, §20, §4.
 *
 * §4 makes this ChatGPT's and Jatin's deliverable, not the engineering
 * layer's. The screen is a place to put the answer and says nothing about
 * what the answer should be.
 *
 * Saving and activating are separate acts, and the form starts empty while
 * the placeholder is in use: putting engineering-authored text in front of
 * the person writing the real voice is how a voice nobody authored comes
 * into use.
 */
export default async function BrandSettingsPage() {
  const db = getDb();
  const brand = activeBrand(db);
  const provenance = activeBrandProvenance(db);
  const versions = brandVersions(db);

  const drafts = versions.filter((v) => !v.active);

  return (
    <main>
      <h1>Brand voice</h1>

      {provenance.isPlaceholder ? (
        <p className="warn">
          <strong>BRAND VOICE UNDEFINED.</strong> The placeholder is in use.
          Every brief carries a warning and output will stay generic until
          this is real — §57 names that as Risk 1, severity HIGH.
        </p>
      ) : (
        <p className="ok">
          Active: version {provenance.version}, activated by{' '}
          {provenance.activatedBy ?? 'an unrecorded actor'} on{' '}
          {when(provenance.activatedAt)}.
        </p>
      )}

      <section className="panel">
        <h2 className="panel-title">Provenance</h2>
        <div className="row">
          <span className="muted">State</span>
          <span>
            <span className={`tag tag-${provenance.isPlaceholder ? 'INSUFFICIENT_DATA' : 'SUPPORTED'}`}>
              {provenance.isPlaceholder ? 'PLACEHOLDER' : 'REAL'}
            </span>
          </span>
        </div>
        <div className="row">
          <span className="muted">Active version</span>
          <span>{provenance.version ?? 'none'}</span>
        </div>
        <div className="row">
          <span className="muted">Activated by</span>
          <span>{provenance.activatedBy ?? '—'}</span>
        </div>
        <div className="row">
          <span className="muted">Activated at</span>
          <span>{when(provenance.activatedAt)}</span>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">
          {provenance.isPlaceholder ? 'Define the brand voice' : 'Save a new version'}
        </h2>
        <p className="muted small">
          This is strategy, not engineering (§4) — it comes from you and
          ChatGPT and is not proposed here. Saving creates a new version
          rather than overwriting, so a change in voice stays attributable.
          <strong> Saving does not put it into use</strong>: activation is a
          separate, recorded act.
        </p>
        {provenance.isPlaceholder && (
          <p className="muted small">
            The fields start empty on purpose. Nothing here suggests what your
            voice should be.
          </p>
        )}
        <BrandForm initial={provenance.isPlaceholder ? null : brand} />
      </section>

      {drafts.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Drafts not in use</h2>
          <p className="muted small">
            Saved but inert. Activating requires your name, which is recorded
            against the version.
          </p>
          {drafts.map((row) => (
            <div className="row" key={row.version}>
              <span>
                v{row.version}
                <span className="tag"> {row.isPlaceholder ? 'placeholder' : 'draft'}</span>
                {row.note && <span className="muted small"> — {row.note}</span>}
              </span>
              <ActivateForm version={row.version} />
            </div>
          ))}
        </section>
      )}

      {versions.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Versions</h2>
          {versions.map((row) => (
            <div className="row" key={row.version}>
              <span>
                v{row.version}
                {row.active && <span className="tag"> active</span>}
                {row.note && <span className="muted small"> — {row.note}</span>}
              </span>
              <span className="muted small">
                {row.activatedBy
                  ? `activated by ${row.activatedBy}, ${when(row.activatedAt)}`
                  : `saved ${when(row.createdAt)}`}
              </span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

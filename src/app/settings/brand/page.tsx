import { desc } from 'drizzle-orm';

import { brandConfig } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { activeBrand } from '@/application/opportunities';
import { BrandForm } from './controls';

export const dynamic = 'force-dynamic';

/**
 * Brand configuration — PRD §8, §20.
 *
 * §4 makes this ChatGPT's and Jatin's deliverable, not the engineering
 * layer's. The screen is a place to put the answer, and says nothing about
 * what the answer should be.
 */
export default async function BrandSettingsPage() {
  const db = getDb();
  const brand = activeBrand(db);

  const versions = db
    .select({
      id: brandConfig.id,
      version: brandConfig.version,
      active: brandConfig.active,
      note: brandConfig.note,
      createdAt: brandConfig.createdAt,
    })
    .from(brandConfig)
    .orderBy(desc(brandConfig.version))
    .limit(10)
    .all();

  return (
    <main>
      <h1>Brand voice</h1>

      {brand.isPlaceholder ? (
        <p className="warn">
          Currently using the placeholder. Every brief carries a warning, and
          output will stay generic until this is real — §57 names that as Risk
          1, severity HIGH.
        </p>
      ) : (
        <p className="muted">
          Active and in use by new briefs.
        </p>
      )}

      <section className="panel">
        <p className="muted small">
          This is strategy, not engineering (§4) — it should come from you and
          ChatGPT, not be invented here. Saving creates a new version rather
          than overwriting, so a change in voice stays attributable when the
          learning engine later looks at what changed.
        </p>
        <BrandForm brand={brand} />
      </section>

      {versions.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Versions</h2>
          {versions.map((row) => (
            <div className="row" key={row.id}>
              <span>
                v{row.version}
                {row.active && <span className="tag"> active</span>}
                {row.note && (
                  <span className="muted small"> — {row.note}</span>
                )}
              </span>
              <span className="muted small">
                {new Intl.DateTimeFormat('en-IN', {
                  dateStyle: 'medium',
                  timeZone: 'Asia/Kolkata',
                }).format(new Date(row.createdAt))}
              </span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

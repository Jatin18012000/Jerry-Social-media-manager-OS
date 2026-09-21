import { desc, inArray } from 'drizzle-orm';

import { contentItems, contentOpportunities } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { openOpportunities } from '@/application/opportunities';

export const dynamic = 'force-dynamic';

/** Opportunity list — PRD §12. The unit of work is the opportunity. */
export default async function OpportunitiesPage() {
  const db = getDb();
  const opportunities = openOpportunities(db);

  const ids = opportunities.map((o) => o.id);
  const variants =
    ids.length > 0
      ? db
          .select({
            id: contentItems.id,
            opportunityId: contentItems.opportunityId,
            platform: contentItems.platform,
            format: contentItems.format,
            state: contentItems.state,
          })
          .from(contentItems)
          .where(inArray(contentItems.opportunityId, ids))
          .all()
      : [];

  const byOpportunity = new Map<number, typeof variants>();
  for (const variant of variants) {
    if (variant.opportunityId === null) continue;
    const list = byOpportunity.get(variant.opportunityId) ?? [];
    list.push(variant);
    byOpportunity.set(variant.opportunityId, list);
  }

  const recentlyClosed = db
    .select()
    .from(contentOpportunities)
    .where(inArray(contentOpportunities.status, ['EXHAUSTED', 'EXPIRED']))
    .orderBy(desc(contentOpportunities.updatedAt))
    .limit(5)
    .all();

  return (
    <main>
      <h1>Opportunities</h1>
      <p className="muted">
        {opportunities.length} open · one story, many platform variants (§12)
      </p>

      <section className="panel">
        {opportunities.length === 0 && (
          <p className="muted">
            None yet. Promote something from the{' '}
            <a href="/research">research queue</a>.
          </p>
        )}

        {opportunities.map((opportunity) => {
          const items = byOpportunity.get(opportunity.id) ?? [];
          return (
            <article className="item" key={opportunity.id}>
              <div className="item-head">
                <a href={`/opportunities/${opportunity.id}`}>
                  {opportunity.title}
                </a>
                {opportunity.expired && <span className="tag">EXPIRED</span>}
              </div>
              {opportunity.thesis && (
                <p className="summary">{opportunity.thesis}</p>
              )}
              <p className="muted small">
                {items.length === 0
                  ? 'No variants yet'
                  : items
                      .map(
                        (i) => `${i.platform} ${i.format} — ${i.state}`,
                      )
                      .join(' · ')}
              </p>
            </article>
          );
        })}
      </section>

      {recentlyClosed.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Closed</h2>
          {recentlyClosed.map((o) => (
            <div className="row" key={o.id}>
              <span className="muted">{o.title}</span>
              <span className="tag">{o.status}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

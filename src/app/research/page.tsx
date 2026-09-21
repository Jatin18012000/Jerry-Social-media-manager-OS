import { desc, eq, inArray } from 'drizzle-orm';

import { claims, researchItems, sources } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { ManualUrlForm, PollButton, PromoteForm } from './controls';

export const dynamic = 'force-dynamic';

function timeAgo(ms: number | null): string {
  if (ms === null) return 'unknown';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Research triage — PRD §13 (DISCOVERY), §15, §16.
 *
 * Shows what the system found, why it thinks it matters, and what it has
 * proposed as claims. Every claim is shown with its §7.3 type so that an
 * inference is never mistaken for a verified fact at a glance — which is the
 * whole point of typing them.
 */
export default async function ResearchPage() {
  const db = getDb();

  const items = db
    .select({
      id: researchItems.id,
      title: researchItems.title,
      summary: researchItems.summary,
      url: researchItems.url,
      discoveredAt: researchItems.discoveredAt,
      relevanceScore: researchItems.relevanceScore,
      status: researchItems.status,
      sourceName: sources.name,
      credibilityTier: sources.credibilityTier,
    })
    .from(researchItems)
    .innerJoin(sources, eq(researchItems.sourceId, sources.id))
    .where(inArray(researchItems.status, ['NEW', 'TRIAGED']))
    .orderBy(
      desc(researchItems.relevanceScore),
      desc(researchItems.discoveredAt),
    )
    .limit(40)
    .all();

  const itemIds = items.map((i) => i.id);
  const allClaims =
    itemIds.length > 0
      ? db
          .select()
          .from(claims)
          .where(inArray(claims.researchItemId, itemIds))
          .all()
      : [];

  const claimsByItem = new Map<number, typeof allClaims>();
  for (const claim of allClaims) {
    const list = claimsByItem.get(claim.researchItemId) ?? [];
    list.push(claim);
    claimsByItem.set(claim.researchItemId, list);
  }

  const sourceRows = db.select().from(sources).all();
  const broken = sourceRows.filter((s) => s.lastError !== null);

  return (
    <main>
      <h1>Research</h1>
      <p className="muted">
        {items.length} item(s) awaiting triage · {sourceRows.length} source(s)
        configured
      </p>

      <section className="panel">
        <h2 className="panel-title">Add a URL</h2>
        <p className="muted small">
          For anything the feeds never saw — a post on X, a newsletter, a link
          someone sent you.
        </p>
        <ManualUrlForm />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Sources</h2>
          <PollButton />
        </div>
        {broken.length > 0 && (
          <p className="error small">
            {broken.length} source(s) failing:{' '}
            {broken.map((s) => s.name).join(', ')}
          </p>
        )}
        {sourceRows.map((source) => (
          <div className="row" key={source.id}>
            <span>
              {source.name}{' '}
              <span className="tag">{source.credibilityTier}</span>
            </span>
            <span className="muted small">
              {source.lastError
                ? 'failing'
                : `polled ${timeAgo(source.lastPolledAt)}`}
            </span>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">Triage queue</h2>

        {items.length === 0 && (
          <p className="muted">
            Nothing yet. Poll the sources, or paste a URL above.
          </p>
        )}

        {items.map((item) => {
          const itemClaims = claimsByItem.get(item.id) ?? [];
          return (
            <article className="item" key={item.id}>
              <div className="item-head">
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.title}
                </a>
                <span className="score">
                  {((item.relevanceScore ?? 0) * 100).toFixed(0)}
                </span>
              </div>

              <p className="muted small">
                {item.sourceName} · {hostOf(item.url)} ·{' '}
                {timeAgo(item.discoveredAt)} ·{' '}
                <span className="tag">{item.credibilityTier}</span>
              </p>

              {item.summary && <p className="summary">{item.summary}</p>}

              <PromoteForm
                researchItemId={item.id}
                defaultTitle={item.title}
              />

              {itemClaims.length > 0 && (
                <div className="claims">
                  <p className="muted small">
                    {itemClaims.length} proposed claim(s) — all unverified
                    until you check them
                  </p>
                  {itemClaims.map((claim) => (
                    <div className="claim" key={claim.id}>
                      <span className={`tag tag-${claim.claimType}`}>
                        {claim.claimType}
                      </span>
                      <span>{claim.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}

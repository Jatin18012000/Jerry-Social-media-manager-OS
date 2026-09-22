import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { claims, researchItems, sources } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { listPillars, pillarCounts, pillarsForItems } from '@/application/pillars';
import { ManualUrlForm, PollButton, PromoteForm } from './controls';
import {
  PrimaryPillarPicker,
  RemoveSecondaryButton,
  SecondaryPillarForm,
} from './pillar-controls';

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
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ pillar?: string }>;
}) {
  const db = getDb();
  const params = await searchParams;
  const pillars = listPillars(db);
  const counts = pillarCounts(db);

  // 'unclassified' is a filter in its own right, not the absence of one:
  // finding what the classifier could not place is a real triage need.
  const filter = params.pillar ?? '';
  const filterPillar = pillars.find((p) => p.slug === filter) ?? null;
  const filterUnclassified = filter === 'unclassified';

  const pillarWhere = filterUnclassified
    ? isNull(researchItems.primaryPillarId)
    : filterPillar
      ? eq(researchItems.primaryPillarId, filterPillar.id)
      : undefined;

  const items = db
    .select({
      id: researchItems.id,
      title: researchItems.title,
      summary: researchItems.summary,
      url: researchItems.url,
      discoveredAt: researchItems.discoveredAt,
      relevanceScore: researchItems.relevanceScore,
      status: researchItems.status,
      primaryPillarId: researchItems.primaryPillarId,
      sourceName: sources.name,
      credibilityTier: sources.credibilityTier,
    })
    .from(researchItems)
    .innerJoin(sources, eq(researchItems.sourceId, sources.id))
    .where(
      pillarWhere
        ? and(inArray(researchItems.status, ['NEW', 'TRIAGED']), pillarWhere)
        : inArray(researchItems.status, ['NEW', 'TRIAGED']),
    )
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

  const itemPillars = pillarsForItems(db, itemIds);
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
        <h2 className="panel-title">Pillars</h2>
        <p className="muted small">
          The classifier proposes the primary pillar. Secondary pillars are
          assigned by you and by nothing else — early pillar counts are only
          worth having if they are trustworthy. An item that fits none of the
          four is <strong>unclassified</strong>, and is counted as such rather
          than pushed into the nearest pillar.
        </p>
        <div className="form-row">
          <a href="/research" className={filter === '' ? 'tag' : 'link-button'}>
            All
          </a>
          {counts.counts.map((row) => (
            <a
              key={row.pillar.id}
              href={`/research?pillar=${row.pillar.slug}`}
              className={filter === row.pillar.slug ? 'tag' : 'link-button'}
            >
              {row.pillar.name} ({row.primaryCount}
              {row.secondaryCount > 0 && ` +${row.secondaryCount}`})
            </a>
          ))}
          <a
            href="/research?pillar=unclassified"
            className={filterUnclassified ? 'tag' : 'link-button'}
          >
            Unclassified ({counts.unclassified})
          </a>
        </div>
        <p className="muted small">
          A count shown as <code>4 +1</code> is four items whose primary pillar
          this is, plus one you also filed here as a secondary.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">
          Triage queue
          {filterPillar && ` — ${filterPillar.name}`}
          {filterUnclassified && ' — unclassified'}
        </h2>

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

              <div className="pillars">
                <PrimaryPillarPicker
                  researchItemId={item.id}
                  pillars={pillars}
                  current={item.primaryPillarId}
                />
                {/*
                  A div, not a p: the buttons below render forms, and a form
                  inside a paragraph is invalid HTML that React resolves by
                  reparenting — which shows up as a hydration mismatch.
                */}
                <div className="muted small pillar-row">
                  {item.primaryPillarId === null && (
                    <span className="tag">UNCLASSIFIED</span>
                  )}
                  {(itemPillars.get(item.id)?.secondaries ?? []).map((sec) => (
                    <span className="secondary-pillar" key={sec.id}>
                      <span className="tag">
                        also {sec.name}
                        <span className="muted"> · {sec.assignedBy}</span>
                      </span>
                      <RemoveSecondaryButton
                        researchItemId={item.id}
                        pillarId={sec.id}
                      />
                    </span>
                  ))}{' '}
                  <SecondaryPillarForm
                    researchItemId={item.id}
                    pillars={pillars.filter(
                      (p) =>
                        p.id !== item.primaryPillarId &&
                        !(itemPillars.get(item.id)?.secondaries ?? []).some(
                          (s) => s.id === p.id,
                        ),
                    )}
                  />
                </div>
              </div>

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

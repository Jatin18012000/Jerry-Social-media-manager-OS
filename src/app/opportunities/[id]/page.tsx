import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import {
  claims,
  contentItems,
  contentOpportunities,
  opportunityResearch,
  researchItems,
} from '@/db/schema';
import { getDb } from '@/db/runtime';
import { AddVariantForm } from './controls';

export const dynamic = 'force-dynamic';

export default async function OpportunityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const opportunityId = Number(id);
  if (!Number.isInteger(opportunityId)) notFound();

  const db = getDb();

  const opportunity = db
    .select()
    .from(contentOpportunities)
    .where(eq(contentOpportunities.id, opportunityId))
    .get();

  if (!opportunity) notFound();

  const research = db
    .select({
      id: researchItems.id,
      title: researchItems.title,
      url: researchItems.url,
    })
    .from(opportunityResearch)
    .innerJoin(
      researchItems,
      eq(researchItems.id, opportunityResearch.researchItemId),
    )
    .where(eq(opportunityResearch.opportunityId, opportunityId))
    .all();

  const allClaims = db
    .select()
    .from(claims)
    .innerJoin(researchItems, eq(claims.researchItemId, researchItems.id))
    .innerJoin(
      opportunityResearch,
      eq(opportunityResearch.researchItemId, researchItems.id),
    )
    .where(eq(opportunityResearch.opportunityId, opportunityId))
    .all()
    .map((row) => row.claims);

  const variants = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.opportunityId, opportunityId))
    .all();

  const unverified = allClaims.filter(
    (c) => c.verificationStatus === 'UNVERIFIED',
  ).length;

  return (
    <main>
      <p className="muted small">
        <a href="/opportunities">← Opportunities</a>
      </p>
      <h1>{opportunity.title}</h1>
      {opportunity.thesis && <p>{opportunity.thesis}</p>}

      <section className="panel">
        <h2 className="panel-title">Research behind this</h2>
        {research.map((item) => (
          <div className="row" key={item.id}>
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {item.title}
            </a>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">
          Claims ({allClaims.length})
          {unverified > 0 && (
            <span className="error small"> · {unverified} unverified</span>
          )}
        </h2>
        {unverified > 0 && (
          <p className="muted small">
            Variants cannot reach STRATEGY_READY until every claim is checked
            (§16). Verify them on a variant page.
          </p>
        )}
        {allClaims.map((claim) => (
          <div className="claim" key={claim.id}>
            <span className={`tag tag-${claim.claimType}`}>
              {claim.claimType}
            </span>
            <span className="tag">{claim.verificationStatus}</span>
            <span>{claim.text}</span>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">Platform variants</h2>
        {variants.length === 0 && (
          <p className="muted">
            None yet. The same facts, framed per platform (§21).
          </p>
        )}
        {variants.map((variant) => (
          <div className="row" key={variant.id}>
            <a href={`/content/${variant.id}`}>
              {variant.platform} · {variant.format} · {variant.language}
            </a>
            <span className="tag">{variant.state}</span>
          </div>
        ))}
        <AddVariantForm opportunityId={opportunityId} />
      </section>
    </main>
  );
}

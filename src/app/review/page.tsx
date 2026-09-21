import { eq, inArray } from 'drizzle-orm';

import { contentItems, contentOpportunities } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { qaFor } from '@/application/qa';
import { ReviewCard } from './controls';

export const dynamic = 'force-dynamic';

/**
 * The approval queue — PRD §22, §45, §46.
 *
 * §22 makes this the one mandatory gate in V1, and §46 puts a good approval
 * experience above everything else on iPad. So each item shows what a decision
 * actually needs — the content, and what QA flagged — rather than a dense
 * table that has to be clicked through to be understood.
 */
export default async function ReviewPage() {
  const db = getDb();

  const items = db
    .select()
    .from(contentItems)
    .where(inArray(contentItems.state, ['QA', 'READY_FOR_REVIEW']))
    .all();

  const opportunityIds = items
    .map((i) => i.opportunityId)
    .filter((id): id is number => id !== null);

  const opportunities =
    opportunityIds.length > 0
      ? db
          .select()
          .from(contentOpportunities)
          .where(inArray(contentOpportunities.id, opportunityIds))
          .all()
      : [];

  const titleOf = new Map(opportunities.map((o) => [o.id, o.title]));

  const awaitingConfirmation = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.state, 'PUBLISHING'))
    .all();

  const enriched = items.map((item) => ({
    item,
    qa: qaFor(db, item.id),
    opportunityTitle: item.opportunityId
      ? (titleOf.get(item.opportunityId) ?? null)
      : null,
  }));

  const ready = enriched.filter((e) => e.item.state === 'READY_FOR_REVIEW');
  const inQa = enriched.filter((e) => e.item.state === 'QA');

  return (
    <main>
      <h1>Review</h1>
      <p className="muted">
        {ready.length} awaiting your decision
        {inQa.length > 0 && ` · ${inQa.length} still in QA`}
        {awaitingConfirmation.length > 0 &&
          ` · ${awaitingConfirmation.length} awaiting publish confirmation`}
      </p>

      {awaitingConfirmation.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Posted yet?</h2>
          <p className="muted small">
            These were handed to you to post by hand. Nothing is recorded as
            published until you confirm (§40).
          </p>
          {awaitingConfirmation.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              qa={null}
              opportunityTitle={
                item.opportunityId
                  ? (titleOf.get(item.opportunityId) ?? null)
                  : null
              }
              mode="CONFIRM"
            />
          ))}
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Ready for your decision</h2>
        {ready.length === 0 && (
          <p className="muted">Nothing waiting. Good place to be.</p>
        )}
        {ready.map(({ item, qa, opportunityTitle }) => (
          <ReviewCard
            key={item.id}
            item={item}
            qa={qa}
            opportunityTitle={opportunityTitle}
            mode="REVIEW"
          />
        ))}
      </section>

      {inQa.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">In QA</h2>
          <p className="muted small">
            Run the gate to move these into the queue. Blockers send them back
            for revision instead.
          </p>
          {inQa.map(({ item, qa, opportunityTitle }) => (
            <ReviewCard
              key={item.id}
              item={item}
              qa={qa}
              opportunityTitle={opportunityTitle}
              mode="QA"
            />
          ))}
        </section>
      )}
    </main>
  );
}

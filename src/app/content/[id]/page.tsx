import { desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { briefs, contentItems, generations } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { scopedClaims, scopedClaimsWithIds } from '@/application/opportunities';
import { historyOf } from '@/application/content';
import {
  BriefPanel,
  ClaimVerifier,
  ComposeBriefButton,
  EditContentForm,
} from './controls';

export const dynamic = 'force-dynamic';

/**
 * The content item screen — PRD §17, §23, decision D3.
 *
 * This is the screen used most: verify claims, build the brief, paste the
 * response back. Its job is to make that loop fast without ever letting an
 * unverified claim look verified (§7.3).
 */
export default async function ContentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const contentItemId = Number(id);
  if (!Number.isInteger(contentItemId)) notFound();

  const db = getDb();

  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .get();

  if (!item) notFound();

  const claimList = scopedClaims(db, contentItemId);
  const unverified = claimList.filter(
    (c) => c.verificationStatus === 'UNVERIFIED',
  );

  const claimRows = scopedClaimsWithIds(db, contentItemId);

  const latestBrief = db
    .select()
    .from(briefs)
    .where(eq(briefs.contentItemId, contentItemId))
    .orderBy(desc(briefs.id))
    .get();

  const latestGeneration = db
    .select()
    .from(generations)
    .where(eq(generations.contentItemId, contentItemId))
    .orderBy(desc(generations.id))
    .get();

  const history = historyOf(db, contentItemId);

  return (
    <main>
      <p className="muted small">
        {item.opportunityId && (
          <a href={`/opportunities/${item.opportunityId}`}>← Opportunity</a>
        )}
      </p>

      <h1>
        {item.platform} · {item.format}
      </h1>
      <p>
        <span className="state-banner">{item.state}</span>{' '}
        <span className="muted small">
          {item.language} · {item.characterMode}
        </span>
      </p>

      <section className="panel">
        <h2 className="panel-title">
          Claims ({claimRows.length})
          {unverified.length > 0 && (
            <span className="error small">
              {' '}· {unverified.length} unverified
            </span>
          )}
        </h2>
        <p className="muted small">
          Nothing reaches STRATEGY_READY while a claim is unverified (§16), and
          only a verified FACT may be stated as fact (§7.3).
        </p>
        {claimRows.map((claim) => (
          <ClaimVerifier
            key={claim.id}
            claimId={claim.id}
            contentItemId={contentItemId}
            text={claim.text}
            claimType={claim.claimType}
            status={claim.verificationStatus}
          />
        ))}
        {claimRows.length === 0 && (
          <p className="muted small">
            No claims attached. This item rests on no external assertion.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Brief</h2>
        {!latestBrief && (
          <>
            <p className="muted small">
              {item.state === 'STRATEGY_READY' || item.state === 'NEEDS_REVISION'
                ? 'Ready to compose.'
                : `The item is in ${item.state}. Verify claims and walk it to STRATEGY_READY first.`}
            </p>
            <ComposeBriefButton contentItemId={contentItemId} />
          </>
        )}
        {latestBrief && (
          <BriefPanel
            contentItemId={contentItemId}
            briefId={latestBrief.id}
            promptText={latestBrief.promptText}
          />
        )}
      </section>

      <section className="panel">
          <h2 className="panel-title">Content</h2>
          {latestGeneration && !latestGeneration.parsedOk && (
            <p className="warn small">
              The last paste could not be read automatically — the raw text is
              kept below as the body. Nothing was lost.
            </p>
          )}
          {item.hook && (
            <div className="field">
              <span className="field-label">Hook</span>
              <p className="field-value">{item.hook}</p>
            </div>
          )}
          {item.body && (
            <div className="field">
              <span className="field-label">Body</span>
              <p className="field-value">{item.body}</p>
            </div>
          )}
          {item.caption && (
            <div className="field">
              <span className="field-label">Caption</span>
              <p className="field-value">{item.caption}</p>
            </div>
          )}
          {item.cta && (
            <div className="field">
              <span className="field-label">CTA</span>
              <p className="field-value">{item.cta}</p>
            </div>
          )}
          {item.hashtags && (
            <div className="field">
              <span className="field-label">Hashtags</span>
              <p className="field-value">{item.hashtags}</p>
            </div>
          )}
          {item.altText && (
            <div className="field">
              <span className="field-label">Alt text</span>
              <p className="field-value">{item.altText}</p>
            </div>
          )}

          {!item.hook && !item.body && !item.caption && (
            <p className="muted small">
              Nothing written yet. Compose a brief above, or write it by hand.
            </p>
          )}

          <EditContentForm
            contentItemId={contentItemId}
            state={item.state}
            fields={{
              hook: item.hook,
              body: item.body,
              caption: item.caption,
              cta: item.cta,
              hashtags: item.hashtags,
              altText: item.altText,
            }}
          />
        </section>

      <section className="panel">
        <h2 className="panel-title">History</h2>
        {history.map((event) => (
          <div className="row" key={event.id}>
            <span className="small">
              {event.fromState} → <strong>{event.toState}</strong>
              {event.note ? ` · ${event.note}` : ''}
            </span>
            <span className="muted small">{event.actor}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

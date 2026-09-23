import { desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { briefs, contentItems, generations } from '@/db/schema';
import { getDb } from '@/db/runtime';
import { scopedClaims, scopedClaimsWithIds } from '@/application/opportunities';
import { historyOf, nextPipelineStep } from '@/application/content';
import {
  AdvanceButton,
  BriefPanel,
  ClaimVerifier,
  ComposeBriefButton,
  EditContentForm,
  SendToReviewButton,
} from './controls';

export const dynamic = 'force-dynamic';

/**
 * What each pipeline step is called for a person.
 *
 * Labels only — which step is legal is decided by the domain and reported by
 * `nextPipelineStep`. If a state is missing here the button still works and
 * simply reads "Move to X", because a missing label must not be able to
 * strand an item the way a missing control already did once.
 */
const STEP_LABELS: Readonly<Record<string, string>> = {
  RESEARCHING: 'Start research',
  RESEARCH_VERIFIED: 'Mark research verified',
  STRATEGY_READY: 'Prepare strategy',
};

/** Where an item goes next when a dedicated screen or action owns the step. */
const HANDED_OFF: Readonly<Record<string, string>> = {
  STRATEGY_READY: 'Compose the brief below to start generating.',
  GENERATING: 'Paste the generated content back in the Brief panel below.',
  NEEDS_REVISION:
    'Edit the content below, then compose a brief again — a revision must ' +
    'pass QA and review afresh.',
  READY_FOR_REVIEW: 'Waiting for your decision on the Review screen.',
  APPROVED: 'Approved. Schedule it from the Schedule screen.',
  SCHEDULED: 'Scheduled. The runner will publish it when it is due.',
  PUBLISHING: 'Publishing — confirm it on the Review screen once posted.',
  PUBLISHED: 'Published. Capture metrics on the Analytics screen.',
  ANALYZING: 'Capturing metrics. Add readings on the Analytics screen.',
  LEARNED: 'Complete. This item has been folded into what the system knows.',
  REJECTED: 'Rejected. This item is closed.',
  CANCELLED: 'Cancelled. This item is closed.',
  FAILED: 'Something failed. Edit it to send it back for revision.',
};

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
  const step = nextPipelineStep(db, contentItemId);

  // buildBrief moves the item to GENERATING, which is legal only from these
  // two states. Offering the button elsewhere exposes an action that fails.
  const canCompose =
    item.state === 'STRATEGY_READY' || item.state === 'NEEDS_REVISION';

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
        <h2 className="panel-title">Lifecycle</h2>
        <p className="muted small">
          This item is in <strong>{item.state}</strong>. Every move is checked
          against the state machine and recorded in the history below — §22
          means nothing reaches a schedule without passing review first.
        </p>

        {step !== null && (
          <>
            <AdvanceButton
              contentItemId={contentItemId}
              to={step.to}
              label={STEP_LABELS[step.to] ?? `Move to ${step.to}`}
            />
            {step.to === 'STRATEGY_READY' && claimRows.length > 0 && (
              <p className="muted small">
                Every attached claim must be verified first (§16). Unverified
                ones will block this step and say so.
              </p>
            )}
          </>
        )}

        {item.state === 'QA' && <SendToReviewButton contentItemId={contentItemId} />}

        {step === null && item.state !== 'QA' && (
          <p className="muted small">
            {HANDED_OFF[item.state] ??
              'No pipeline action from here — see the history below.'}
          </p>
        )}

        {item.state === 'READY_FOR_REVIEW' && (
          <p className="small">
            <a href="/review">Go to Review →</a>
          </p>
        )}
      </section>

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
        {/*
          Offered whenever composing is legal, whether or not a brief already
          exists. Hiding it once any brief had been written stranded items that
          picked one up early: the only way into GENERATING is to compose, so
          an item with a stale brief had no way forward at all.
        */}
        {canCompose && (
          <>
            <p className="muted small">
              {latestBrief
                ? 'Composing again writes a fresh brief from the current claims and content, and moves this item to GENERATING.'
                : 'Ready to compose.'}
            </p>
            <ComposeBriefButton contentItemId={contentItemId} />
          </>
        )}

        {!canCompose && !latestBrief && (
          // An action that cannot legally run should not be offered.
          <p className="muted small">
            The item is in {item.state}. Composing a brief starts generation,
            which is only legal from STRATEGY_READY or NEEDS_REVISION — use the
            Lifecycle panel above to get there.
          </p>
        )}

        {latestBrief && (
          <>
            {item.state !== 'GENERATING' && (
              // Pasting a response only advances the item from GENERATING.
              // Anywhere else it saves the generation and changes no state,
              // which from the outside looks exactly like nothing happening.
              <p className="warn small">
                This brief was composed earlier. Pasting a response here will
                be saved but will <strong>not</strong> move the item on —
                that only happens from GENERATING.
                {canCompose
                  ? ' Compose a fresh brief above to get there.'
                  : ' Use the Lifecycle panel above to get there.'}
              </p>
            )}
            <BriefPanel
              contentItemId={contentItemId}
              briefId={latestBrief.id}
              promptText={latestBrief.promptText}
            />
          </>
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

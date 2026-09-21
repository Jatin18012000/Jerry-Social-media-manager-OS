'use client';

import { useActionState, useState } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  applyContentAction,
  confirmPublished,
  schedule,
  sendToReview,
} from '@/application/schedule-actions';
import type { QaReport } from '@/domain/qa';

interface Item {
  id: number;
  platform: string;
  format: string;
  language: string;
  characterMode: string;
  state: string;
  hook: string | null;
  body: string | null;
  caption: string | null;
  cta: string | null;
  hashtags: string | null;
  altText: string | null;
}

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? 'ok small' : 'error small'}>{state.message}</p>
  );
}

/**
 * One reviewable item.
 *
 * Shows the content as it will read, then what QA flagged. §22 makes this the
 * only mandatory gate, so the decision has to be makeable from the card
 * itself — not after clicking through to somewhere else.
 */
export function ReviewCard({
  item,
  qa,
  opportunityTitle,
  mode,
}: {
  item: Item;
  qa: QaReport | null;
  opportunityTitle: string | null;
  mode: 'REVIEW' | 'QA' | 'CONFIRM';
}) {
  return (
    <article className="review-card">
      <div className="item-head">
        <span>
          <strong>
            {item.platform} · {item.format}
          </strong>{' '}
          <span className="muted small">
            {item.language} · {item.characterMode}
          </span>
        </span>
        <a className="small" href={`/content/${item.id}`}>
          Open
        </a>
      </div>

      {opportunityTitle && (
        <p className="muted small">{opportunityTitle}</p>
      )}

      {item.hook && <p className="review-hook">{item.hook}</p>}
      {item.caption && <p className="field-value">{item.caption}</p>}
      {item.hashtags && (
        <p className="muted small">
          {item.hashtags
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((t) => `#${t}`)
            .join(' ')}
        </p>
      )}
      {!item.altText && item.format !== 'TEXT' && (
        <p className="warn small">No alt text.</p>
      )}

      {qa && qa.findings.length > 0 && (
        <div className="qa">
          {qa.findings.map((finding) => (
            <p
              key={finding.code}
              className={
                finding.severity === 'BLOCKER' ? 'error small' : 'warn small'
              }
            >
              {finding.severity === 'BLOCKER' ? '✕' : '!'} {finding.message}
            </p>
          ))}
        </div>
      )}

      {mode === 'QA' && <RunQaButton contentItemId={item.id} />}
      {mode === 'REVIEW' && <ReviewActions contentItemId={item.id} />}
      {mode === 'CONFIRM' && <ConfirmPublished contentItemId={item.id} />}
    </article>
  );
}

function RunQaButton({ contentItemId }: { contentItemId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    sendToReview,
    null,
  );
  return (
    <form action={action} className="form-row">
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Run QA'}
      </button>
      <Result state={state} />
    </form>
  );
}

function ReviewActions({ contentItemId }: { contentItemId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    applyContentAction,
    null,
  );
  const [approved, setApproved] = useState(false);

  return (
    <>
      <form action={action} className="form-row">
        <input type="hidden" name="contentItemId" value={contentItemId} />
        <button
          type="submit"
          name="action"
          value="APPROVE"
          disabled={pending}
          onClick={() => setApproved(true)}
        >
          Approve
        </button>
        <button
          type="submit"
          name="action"
          value="EDIT"
          className="secondary"
          disabled={pending}
        >
          Needs changes
        </button>
        <button
          type="submit"
          name="action"
          value="REJECT"
          className="secondary"
          disabled={pending}
        >
          Reject
        </button>
        <Result state={state} />
      </form>

      {(approved || state?.message?.includes('APPROVED')) && (
        <ScheduleForm contentItemId={contentItemId} />
      )}
    </>
  );
}

export function ScheduleForm({ contentItemId }: { contentItemId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    schedule,
    null,
  );

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <input
        type="datetime-local"
        name="runAt"
        required
        aria-label="When to publish"
      />
      <input type="hidden" name="timezone" value="Asia/Kolkata" />
      <button type="submit" disabled={pending}>
        {pending ? 'Scheduling…' : 'Schedule'}
      </button>
      <Result state={state} />
    </form>
  );
}

function ConfirmPublished({ contentItemId }: { contentItemId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    confirmPublished,
    null,
  );

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <input
        type="url"
        name="externalUrl"
        placeholder="Paste the post URL (optional)"
        aria-label="Published post URL"
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Recording…' : 'I posted it'}
      </button>
      <Result state={state} />
    </form>
  );
}

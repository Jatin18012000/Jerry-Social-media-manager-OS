'use client';

import { useActionState, useState } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  composeBriefFor,
  submitClaimVerification,
  submitGeneration,
} from '@/application/content-actions';

export function ComposeBriefButton({
  contentItemId,
}: {
  contentItemId: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    composeBriefFor,
    null,
  );

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <button type="submit" disabled={pending}>
        {pending ? 'Composing…' : 'Compose brief'}
      </button>
      {state && (
        <p className={state.ok ? 'ok small' : 'error small'}>{state.message}</p>
      )}
    </form>
  );
}

/**
 * Brief out, response in — the loop decision D3 chose.
 *
 * Copy is one click because this happens several times a day. The paste box
 * accepts anything: a failed parse still persists the text (the server never
 * rejects a paste), so the writer's effort is never spent twice.
 */
export function BriefPanel({
  contentItemId,
  briefId,
  promptText,
}: {
  contentItemId: number;
  briefId: number;
  promptText: string;
}) {
  const [copied, setCopied] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    submitGeneration,
    null,
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the text is on screen to select.
      setCopied(false);
    }
  };

  return (
    <>
      <div className="form-row">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy brief'}
        </button>
        <span className="muted small">
          Paste into Claude or Gemini, then paste the reply below.
        </span>
      </div>

      <pre className="brief">{promptText}</pre>

      <form action={action}>
        <input type="hidden" name="contentItemId" value={contentItemId} />
        <input type="hidden" name="briefId" value={briefId} />

        <label className="field-label" htmlFor="rawResponse">
          Paste the response
        </label>
        <textarea
          id="rawResponse"
          name="rawResponse"
          placeholder="Paste whatever came back — JSON, markdown, or plain prose."
        />

        <div className="form-row">
          <select name="provider" aria-label="Which model produced this">
            <option value="">Which model?</option>
            <option value="claude.ai">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="chatgpt">ChatGPT</option>
          </select>
          <button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save response'}
          </button>
          {state && (
            <p className={state.ok ? 'ok small' : 'warn small'}>
              {state.message}
            </p>
          )}
        </div>
      </form>
    </>
  );
}

const TIERS = [
  'PRIMARY',
  'OFFICIAL_DOCS',
  'ORIGINAL_RESEARCH',
  'CREDIBLE_SECONDARY',
  'OTHER',
];

/**
 * §7.2: marking a claim verified requires saying what verified it, and at
 * which tier. The form cannot submit VERIFIED without both — and the
 * application layer and a database CHECK refuse it independently.
 */
export function ClaimVerifier({
  claimId,
  contentItemId,
  text,
  claimType,
  status,
}: {
  claimId: number;
  contentItemId: number;
  text: string;
  claimType: string;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const [wantsVerified, setWantsVerified] = useState(true);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    submitClaimVerification,
    null,
  );

  return (
    <div className="claim-block">
      <div className="claim">
        <span className={`tag tag-${claimType}`}>{claimType}</span>
        <span className={status === 'UNVERIFIED' ? 'tag warn' : 'tag'}>
          {status}
        </span>
        <span>{text}</span>
      </div>

      {status === 'UNVERIFIED' && !open && (
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen(true)}
        >
          Check this claim
        </button>
      )}

      {open && (
        <form action={action} className="form-row">
          <input type="hidden" name="claimId" value={claimId} />
          <input type="hidden" name="contentItemId" value={contentItemId} />

          <select
            name="status"
            aria-label="Verification outcome"
            onChange={(e) => setWantsVerified(e.target.value === 'VERIFIED')}
          >
            <option value="VERIFIED">Verified</option>
            <option value="DISPUTED">Disputed</option>
            <option value="UNVERIFIABLE">Could not verify</option>
          </select>

          {wantsVerified && (
            <>
              <input
                type="url"
                name="evidenceUrl"
                placeholder="Evidence URL"
                required
                aria-label="Evidence URL"
              />
              <select name="evidenceTier" aria-label="Evidence tier" required>
                {TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </>
          )}

          <button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Record'}
          </button>
          {state && (
            <p className={state.ok ? 'ok small' : 'error small'}>
              {state.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

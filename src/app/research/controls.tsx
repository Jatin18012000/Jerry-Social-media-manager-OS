'use client';

import { useActionState, useState, useTransition } from 'react';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import type { ActionResult } from '@/application/action-result';
import { addManualUrl, pollSources } from '@/application/actions';
import { promoteResearch } from '@/application/content-actions';

export function ManualUrlForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    addManualUrl,
    null,
  );

  return (
    <form action={action} className="form-row">
      <input
        type="url"
        name="url"
        placeholder="https://..."
        required
        aria-label="URL to add"
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Reading…' : 'Add'}
      </button>
      {state && (
        <p className={state.ok ? 'ok small' : 'error small'}>{state.message}</p>
      )}
    </form>
  );
}

export function PollButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span className="poll">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await pollSources());
          })
        }
      >
        {pending ? 'Polling…' : 'Poll sources'}
      </button>
      {result && (
        <span className={result.ok ? 'ok small' : 'error small'}>
          {result.message}
        </span>
      )}
    </span>
  );
}

/**
 * Promotes a research item into a Content Opportunity (§12).
 *
 * The title defaults to the item's own, because the common case is that the
 * headline is already the story. It stays editable because sometimes it isn't.
 */
export function PromoteForm({
  researchItemId,
  defaultTitle,
}: {
  researchItemId: number;
  defaultTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    promoteResearch,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (state?.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state, router]);

  if (!open) {
    return (
      <button
        type="button"
        className="link-button"
        onClick={() => setOpen(true)}
      >
        Promote to opportunity
      </button>
    );
  }

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="researchItemId" value={researchItemId} />
      <input
        type="text"
        name="title"
        defaultValue={defaultTitle}
        required
        aria-label="Opportunity title"
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create'}
      </button>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {state && !state.ok && <p className="error small">{state.message}</p>}
    </form>
  );
}

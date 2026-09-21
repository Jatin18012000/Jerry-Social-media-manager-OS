'use client';

import { useActionState, useState, useTransition } from 'react';

import {
  type ActionResult,
  addManualUrl,
  pollSources,
} from '@/application/actions';

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

'use client';

import { useActionState, useState, useTransition } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  dismissAll,
  dismissNotification,
} from '@/application/notification-actions';

export function DismissButton({ id }: { id: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    dismissNotification,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="link-button" disabled={pending}>
        {pending ? '…' : 'Dismiss'}
      </button>
      {state && !state.ok && <span className="error small">{state.message}</span>}
    </form>
  );
}

export function DismissAllButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span className="poll">
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => setResult(await dismissAll()))
        }
      >
        {pending ? 'Dismissing…' : 'Dismiss all'}
      </button>
      {result && <span className="muted small">{result.message}</span>}
    </span>
  );
}

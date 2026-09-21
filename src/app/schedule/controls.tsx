'use client';

import { useActionState, useState, useTransition } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  resolveMissed,
  runSchedulerNow,
  unschedule,
} from '@/application/schedule-actions';

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <span className={state.ok ? 'ok small' : 'error small'}>
      {state.message}
    </span>
  );
}

export function RunSchedulerButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span className="poll">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => setResult(await runSchedulerNow()))
        }
      >
        {pending ? 'Running…' : 'Run now'}
      </button>
      <Result state={result} />
    </span>
  );
}

export function UnscheduleButton({ contentItemId }: { contentItemId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    unschedule,
    null,
  );

  return (
    <form action={action} className="poll">
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? '…' : 'Unschedule'}
      </button>
      <Result state={state} />
    </form>
  );
}

/**
 * The three ways out of a missed window (decision D2).
 *
 * Rescheduling is the default choice presented, because publishing a
 * morning post in the evening is usually the wrong call — but it stays
 * available, since sometimes it isn't.
 */
export function MissedJobForm({
  jobId,
  contentItemId,
}: {
  jobId: number;
  contentItemId: number;
}) {
  const [resolution, setResolution] = useState('RESCHEDULE');
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    resolveMissed,
    null,
  );

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="contentItemId" value={contentItemId} />

      <select
        name="resolution"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        aria-label="What to do"
      >
        <option value="RESCHEDULE">Reschedule</option>
        <option value="PUBLISH_NOW">Publish now anyway</option>
        <option value="CANCEL">Cancel</option>
      </select>

      {resolution === 'RESCHEDULE' && (
        <input
          type="datetime-local"
          name="runAt"
          required
          aria-label="New time"
        />
      )}

      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Apply'}
      </button>
      <Result state={state} />
    </form>
  );
}

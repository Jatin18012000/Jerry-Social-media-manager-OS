'use client';

import { useActionState, useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';

import type { ActionResult } from '@/application/action-result';
import {
  abandonExperimentAction,
  assignVariantAction,
  concludeExperimentAction,
  createExperimentAction,
  startExperimentAction,
  unassignVariantAction,
} from './actions';

function Message({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? 'ok small' : 'error small'}>{state.message}</p>
  );
}

/**
 * The pre-registration form — §30.
 *
 * Everything it asks for is fixed the moment the experiment starts, so the
 * form says so rather than presenting these as ordinary editable fields.
 */
export function NewExperimentForm({
  metrics,
  defaultHypothesis,
}: {
  metrics: readonly { value: string; label: string }[];
  defaultHypothesis?: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultHypothesis));
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createExperimentAction,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (state?.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state, router]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Register an experiment
      </button>
    );
  }

  return (
    <form action={action} className="stack">
      <p className="muted small">
        These terms are fixed when the experiment starts and cannot be changed
        afterwards. That is the whole mechanism: a metric you can edit once the
        numbers arrive pre-registers nothing.
      </p>

      <label>
        Hypothesis
        <textarea
          name="hypothesis"
          rows={2}
          required
          defaultValue={defaultHypothesis ?? ''}
          placeholder="Hinglish captions earn more follows than English ones."
        />
        <span className="muted small">
          State it so it could turn out to be false.
        </span>
      </label>

      <label>
        Metric
        <select name="metric" defaultValue={metrics[0]?.value ?? ''}>
          {metrics.map((metric) => (
            <option key={metric.value} value={metric.value}>
              {metric.label}
            </option>
          ))}
        </select>
      </label>

      <div className="form-row">
        <label>
          Control arm
          <input name="controlName" required placeholder="English" />
        </label>
        <label>
          Treatment arm
          <input name="treatmentName" required placeholder="Hinglish" />
        </label>
      </div>
      <p className="muted small">
        The treatment is what you expect to win. Fixing the direction now is
        what stops the result being readable either way afterwards.
      </p>

      <label>
        What the control does
        <input
          name="controlDescription"
          required
          placeholder="Caption written entirely in English."
        />
      </label>
      <label>
        What the treatment does
        <input
          name="treatmentDescription"
          required
          placeholder="Caption mixing Hindi and English as spoken."
        />
      </label>

      <label>
        Minimum posts per arm
        <input
          type="number"
          name="minSampleSize"
          min={5}
          defaultValue={5}
          required
        />
        <span className="muted small">
          Per arm, not in total — ten posts split nine-one establishes nothing.
          The experiment cannot be concluded until both arms reach this.
        </span>
      </label>

      <div className="form-row">
        <button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register as draft'}
        </button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function StartButton({ experimentId }: { experimentId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    startExperimentAction,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="experimentId" value={experimentId} />
      <button type="submit" disabled={pending}>
        {pending ? 'Starting…' : 'Start — this fixes the terms'}
      </button>
      {/*
        On success this whole panel unmounts, so what renders here is the
        refusal. The confirmation is the page itself: the terms panel stops
        saying "not yet fixed" and starts saying there is no edit path.
      */}
      <Message state={state} />
    </form>
  );
}

export function AssignForm({
  experimentId,
  arms,
  items,
}: {
  experimentId: number;
  arms: readonly string[];
  items: readonly { id: number; topic: string | null; platform: string; state: string }[];
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    assignVariantAction,
    null,
  );

  if (items.length === 0) {
    return (
      <p className="muted small">
        Nothing to assign. Items already measured cannot join — their results
        are known, so enrolling one would mean choosing a data point by its
        outcome. Create the next post and assign it before it publishes.
      </p>
    );
  }

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="experimentId" value={experimentId} />
      <select name="contentItemId" aria-label="Content item">
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            #{item.id} {item.topic ?? 'Untitled'} ({item.platform}, {item.state})
          </option>
        ))}
      </select>
      <select name="variant" aria-label="Arm">
        {arms.map((arm) => (
          <option key={arm} value={arm}>
            {arm}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending}>
        {pending ? 'Assigning…' : 'Assign'}
      </button>
      <Message state={state} />
    </form>
  );
}

export function UnassignButton({
  experimentId,
  contentItemId,
}: {
  experimentId: number;
  contentItemId: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    unassignVariantAction,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="experimentId" value={experimentId} />
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <button type="submit" className="link-button" disabled={pending}>
        {pending ? '…' : 'Remove'}
      </button>
      {state && !state.ok && <span className="error small">{state.message}</span>}
    </form>
  );
}

export function ConcludeButton({
  experimentId,
  blocker,
}: {
  experimentId: number;
  blocker: string | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    concludeExperimentAction,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="experimentId" value={experimentId} />
      {/*
        Disabled *and* refused server-side. The button is a courtesy; the
        refusal in the use case is what actually prevents optional stopping.
      */}
      <button type="submit" disabled={pending || blocker !== null}>
        {pending ? 'Concluding…' : 'Conclude on the registered terms'}
      </button>
      {blocker && <p className="warn small">{blocker}</p>}
      {/*
        As with Start: on success this panel is replaced by the Result panel,
        which states the verdict and what it earned. What shows here is the
        refusal — the case that matters.
      */}
      <Message state={state} />
    </form>
  );
}

export function AbandonForm({ experimentId }: { experimentId: number }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    abandonExperimentAction,
    null,
  );

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Abandon
      </button>
    );
  }

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="experimentId" value={experimentId} />
      <input name="reason" placeholder="Why it is being abandoned" required />
      <button type="submit" disabled={pending}>
        {pending ? 'Abandoning…' : 'Abandon'}
      </button>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <Message state={state} />
    </form>
  );
}

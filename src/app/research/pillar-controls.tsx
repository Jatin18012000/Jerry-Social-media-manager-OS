'use client';

import { useActionState, useState } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  addSecondaryPillarAction,
  removeSecondaryPillarAction,
  setPrimaryPillarAction,
} from './pillar-actions';

export interface PillarOption {
  readonly id: number;
  readonly name: string;
}

function Message({ state }: { state: ActionResult | null }) {
  if (!state || state.ok) return null;
  return <span className="error small">{state.message}</span>;
}

/**
 * Primary pillar, editable.
 *
 * "Unclassified" is a real option rather than an absence of choice — §7.1
 * means an item that fits none of the four pillars must be able to say so
 * instead of being pushed into the nearest one.
 */
export function PrimaryPillarPicker({
  researchItemId,
  pillars,
  current,
}: {
  researchItemId: number;
  pillars: readonly PillarOption[];
  current: number | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    setPrimaryPillarAction,
    null,
  );

  return (
    <form action={action} className="pillar-row">
      <input type="hidden" name="researchItemId" value={researchItemId} />
      <select
        name="pillarId"
        defaultValue={current === null ? '' : String(current)}
        aria-label="Primary pillar"
      >
        <option value="">Unclassified</option>
        {pillars.map((pillar) => (
          <option key={pillar.id} value={pillar.id}>
            {pillar.name}
          </option>
        ))}
      </select>
      <button type="submit" className="link-button" disabled={pending}>
        {pending ? 'Saving…' : 'Set primary'}
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * Secondary pillars, human-assigned.
 *
 * The name field is not a formality. Nothing else writes these rows, and a
 * secondary pillar with no assigner would be indistinguishable from the
 * machine guess this design deliberately refuses to make.
 */
export function SecondaryPillarForm({
  researchItemId,
  pillars,
}: {
  researchItemId: number;
  pillars: readonly PillarOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    addSecondaryPillarAction,
    null,
  );

  if (pillars.length === 0) return null;

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        + secondary pillar
      </button>
    );
  }

  return (
    <form action={action} className="pillar-row">
      <input type="hidden" name="researchItemId" value={researchItemId} />
      <select name="pillarId" aria-label="Secondary pillar">
        {pillars.map((pillar) => (
          <option key={pillar.id} value={pillar.id}>
            {pillar.name}
          </option>
        ))}
      </select>
      <input name="assignedBy" placeholder="Your name" aria-label="Your name" required />
      <button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add'}
      </button>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <Message state={state} />
    </form>
  );
}

export function RemoveSecondaryButton({
  researchItemId,
  pillarId,
}: {
  researchItemId: number;
  pillarId: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    removeSecondaryPillarAction,
    null,
  );

  return (
    <form action={action} style={{ display: 'inline' }}>
      <input type="hidden" name="researchItemId" value={researchItemId} />
      <input type="hidden" name="pillarId" value={pillarId} />
      <button type="submit" className="link-button" disabled={pending}>
        ×
      </button>
      <Message state={state} />
    </form>
  );
}

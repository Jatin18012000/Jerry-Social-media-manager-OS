'use server';

/**
 * Pillar assignment from the research screen — §10.
 *
 * The primary pillar may have come from the classifier; these actions let a
 * human correct it. Secondary pillars are human-assigned only and are never
 * written by a model or a heuristic, so every one of them carries the name of
 * whoever assigned it.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { ActionResult } from '@/application/action-result';
import {
  PillarError,
  addSecondaryPillar,
  removeSecondaryPillar,
  setPrimaryPillar,
} from '@/application/pillars';

function failed(error: unknown): ActionResult {
  if (error instanceof PillarError) {
    return { ok: false, message: error.message };
  }
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function setPrimaryPillarAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const researchItemId = Number(formData.get('researchItemId'));
  const raw = String(formData.get('pillarId') ?? '');

  // The empty option means UNCLASSIFIED, which must stay reachable: a human
  // correcting a wrong classification needs to be able to say "none of these".
  const pillarId = raw === '' ? null : Number(raw);

  try {
    setPrimaryPillar(getDb(), researchItemId, pillarId);
    revalidatePath('/research');
    return {
      ok: true,
      message: pillarId === null ? 'Marked unclassified.' : 'Primary pillar set.',
    };
  } catch (error) {
    return failed(error);
  }
}

export async function addSecondaryPillarAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const assignedBy = String(formData.get('assignedBy') ?? '').trim();

  if (!assignedBy) {
    return {
      ok: false,
      message:
        'Type your name. Secondary pillars are human-assigned, and an ' +
        'unattributed one would be exactly the machine guess this avoids.',
    };
  }

  try {
    addSecondaryPillar(getDb(), {
      researchItemId: Number(formData.get('researchItemId')),
      pillarId: Number(formData.get('pillarId')),
      assignedBy,
    });
    revalidatePath('/research');
    return { ok: true, message: 'Secondary pillar added.' };
  } catch (error) {
    return failed(error);
  }
}

export async function removeSecondaryPillarAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    removeSecondaryPillar(
      getDb(),
      Number(formData.get('researchItemId')),
      Number(formData.get('pillarId')),
    );
    revalidatePath('/research');
    return { ok: true, message: 'Removed.' };
  } catch (error) {
    return failed(error);
  }
}

'use server';

/**
 * Server actions for the experiments screens — §30.
 *
 * Every refusal these surface comes from the domain or the use case. Nothing
 * here decides whether an experiment may start, take an assignment or be
 * concluded; it translates the answer into something a form can show.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { ActionResult } from '@/application/action-result';
import {
  abandonExperiment,
  assignVariant,
  concludeExperiment,
  createExperiment,
  startExperiment,
  unassignVariant,
} from '@/application/experiments';

function failed(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function refresh(id?: number) {
  revalidatePath('/experiments');
  if (id !== undefined) revalidatePath(`/experiments/${id}`);
  revalidatePath('/analytics');
}

export async function createExperimentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const raw = formData.get('minSampleSize');
  const parsed = raw === null || String(raw).trim() === '' ? NaN : Number(raw);

  const result = createExperiment(getDb(), {
    hypothesis: String(formData.get('hypothesis') ?? ''),
    metric: String(formData.get('metric') ?? ''),
    controlName: String(formData.get('controlName') ?? ''),
    controlDescription: String(formData.get('controlDescription') ?? ''),
    treatmentName: String(formData.get('treatmentName') ?? ''),
    treatmentDescription: String(formData.get('treatmentDescription') ?? ''),
    // NaN rather than 0, so "not a number" is not silently a valid-looking
    // sample size that then fails the integer check with a confusing message.
    minSampleSize: Number.isNaN(parsed) ? null : parsed,
  });

  if (!result.ok) {
    // Every problem at once. Being told one at a time is a poor way to find
    // out there were four.
    return { ok: false, message: (result.errors ?? []).join(' ') };
  }

  refresh(result.id);
  return {
    ok: true,
    message: 'Registered as a draft. Nothing is fixed until you start it.',
    redirectTo: `/experiments/${result.id}`,
  };
}

export async function startExperimentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get('experimentId'));
  try {
    startExperiment(getDb(), id);
    refresh(id);
    return {
      ok: true,
      message:
        'Running. The hypothesis, metric, arms and minimum sample size are ' +
        'now fixed — there is no edit path.',
    };
  } catch (error) {
    return failed(error);
  }
}

export async function assignVariantAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const experimentId = Number(formData.get('experimentId'));
  try {
    assignVariant(getDb(), {
      experimentId,
      contentItemId: Number(formData.get('contentItemId')),
      variant: String(formData.get('variant') ?? ''),
    });
    refresh(experimentId);
    return { ok: true, message: 'Assigned.' };
  } catch (error) {
    return failed(error);
  }
}

export async function unassignVariantAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const experimentId = Number(formData.get('experimentId'));
  try {
    unassignVariant(getDb(), {
      experimentId,
      contentItemId: Number(formData.get('contentItemId')),
    });
    refresh(experimentId);
    return { ok: true, message: 'Removed.' };
  } catch (error) {
    return failed(error);
  }
}

export async function concludeExperimentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get('experimentId'));
  try {
    const report = concludeExperiment(getDb(), id);
    refresh(id);

    const earned =
      report.findingId === null
        ? ' No finding was earned — the result is recorded here, where the ' +
          'terms that produced it are visible.'
        : ' Recorded as a SUPPORTED finding on the Analytics page.';

    return {
      ok: true,
      message: `${report.conclusion.verdict}.${earned}`,
    };
  } catch (error) {
    return failed(error);
  }
}

export async function abandonExperimentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get('experimentId'));
  try {
    abandonExperiment(getDb(), id, String(formData.get('reason') ?? ''));
    refresh(id);
    return {
      ok: true,
      message: 'Abandoned. No verdict was recorded, because none was reached.',
    };
  } catch (error) {
    return failed(error);
  }
}

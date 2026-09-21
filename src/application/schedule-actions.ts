'use server';

/**
 * Server actions for the review and schedule screens — PRD §22, §23, §24.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import { createPublisherRegistry } from '@/adapters/publishers';
import type { ActionResult } from './action-result';
import { act } from './content';
import { submitForReview } from './qa';
import {
  confirmManualPublish,
  resolveMissedJob,
  runDueJobs,
  scheduleItem,
  unscheduleItem,
} from './schedule';

export type { ActionResult } from './action-result';

function fail(error: unknown, prefix: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, message: `${prefix}: ${message}` };
}

function refresh(contentItemId: number): void {
  revalidatePath('/review');
  revalidatePath('/schedule');
  revalidatePath(`/content/${contentItemId}`);
}

/** Runs the QA gate and, if it passes, puts the item in the review queue. */
export async function sendToReview(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));

  try {
    const result = submitForReview(getDb(), contentItemId, { actor: 'jatin' });
    refresh(contentItemId);

    if (!result.ok) {
      return {
        ok: false,
        message: `QA blocked it: ${result.report.blockers
          .map((b) => b.message)
          .join(' ')}`,
      };
    }

    return {
      ok: true,
      message:
        result.report.warnings.length > 0
          ? `Ready for review, with ${result.report.warnings.length} warning(s).`
          : 'Ready for review.',
    };
  } catch (error) {
    return fail(error, 'Could not run QA');
  }
}

/** Applies one of §23's actions. */
export async function applyContentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const action = String(formData.get('action') ?? '') as
    | 'APPROVE'
    | 'REJECT'
    | 'EDIT'
    | 'REGENERATE'
    | 'CANCEL';
  const note = String(formData.get('note') ?? '').trim();

  try {
    const state = act(getDb(), contentItemId, action, {
      actor: 'jatin',
      ...(note ? { note } : {}),
    });
    refresh(contentItemId);
    return { ok: true, message: `Now ${state}.` };
  } catch (error) {
    return fail(error, 'Could not do that');
  }
}

/** Schedules an approved item (§24). */
export async function schedule(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const when = String(formData.get('runAt') ?? '').trim();
  const timezone = String(formData.get('timezone') ?? 'Asia/Kolkata');

  if (!when) return { ok: false, message: 'Pick a date and time.' };

  try {
    scheduleItem(getDb(), {
      contentItemId,
      runAt: new Date(when),
      timezone,
      actor: 'jatin',
    });
    refresh(contentItemId);
    return { ok: true, message: 'Scheduled.' };
  } catch (error) {
    return fail(error, 'Could not schedule it');
  }
}

export async function unschedule(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));

  try {
    unscheduleItem(getDb(), contentItemId, { actor: 'jatin' });
    refresh(contentItemId);
    return { ok: true, message: 'Unscheduled — still approved.' };
  } catch (error) {
    return fail(error, 'Could not unschedule it');
  }
}

/**
 * Confirms a human actually posted something — decision D1.
 *
 * The only route from PUBLISHING to PUBLISHED while the manual publisher is
 * in use. The system cannot confirm on anyone's behalf (§40).
 */
export async function confirmPublished(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const externalUrl = String(formData.get('externalUrl') ?? '').trim();

  try {
    confirmManualPublish(getDb(), {
      contentItemId,
      ...(externalUrl ? { externalUrl } : {}),
      confirmedBy: 'jatin',
    });
    refresh(contentItemId);
    return { ok: true, message: 'Recorded as published.' };
  } catch (error) {
    return fail(error, 'Could not record that');
  }
}

/** Decides what to do about a window the machine slept through (D2). */
export async function resolveMissed(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const jobId = Number(formData.get('jobId'));
  const contentItemId = Number(formData.get('contentItemId'));
  const resolution = String(formData.get('resolution') ?? '') as
    | 'PUBLISH_NOW'
    | 'RESCHEDULE'
    | 'CANCEL';
  const runAt = String(formData.get('runAt') ?? '').trim();

  try {
    resolveMissedJob(getDb(), jobId, resolution, {
      actor: 'jatin',
      ...(runAt ? { runAt: new Date(runAt) } : {}),
    });
    refresh(contentItemId);
    return { ok: true, message: 'Done.' };
  } catch (error) {
    return fail(error, 'Could not resolve it');
  }
}

/** Runs due jobs on demand, rather than waiting for the next poll. */
export async function runSchedulerNow(): Promise<ActionResult> {
  try {
    const publishers = createPublisherRegistry(
      process.env.PUBLISHER_MODE === 'LIVE' ? 'LIVE' : 'MANUAL',
    );
    const report = await runDueJobs(getDb(), (p) => publishers.for(p));
    revalidatePath('/schedule');

    return {
      ok: report.failed === 0,
      message:
        `${report.considered} due · ${report.published} published · ` +
        `${report.awaitingHuman} awaiting you · ${report.missed} missed · ` +
        `${report.failed} failed`,
    };
  } catch (error) {
    return fail(error, 'Runner failed');
  }
}

'use server';

/**
 * Server action for recomputing findings — PRD §29.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { ActionResult } from './action-result';
import { recomputeAll } from './learning';

export type { ActionResult } from './action-result';

export async function recomputeLearning(): Promise<ActionResult> {
  try {
    const reports = recomputeAll(getDb());
    revalidatePath('/analytics');
    revalidatePath('/');

    const observations = Math.max(...reports.map((r) => r.observations));
    const shown = reports.reduce((sum, r) => sum + r.presentable, 0);

    return {
      ok: true,
      message:
        shown === 0
          ? `Analysed ${observations} measured post(s) — still too few for any finding to stand up (§29).`
          : `Analysed ${observations} measured post(s): ${shown} finding(s) worth showing.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not recompute: ${message}` };
  }
}

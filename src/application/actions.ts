'use server';

/**
 * Server actions for the research screens.
 *
 * These are the application layer's entry points from the UI. They own the
 * transaction boundary and the revalidation; the use cases in ingest.ts own
 * the logic. Nothing here reimplements a rule that lives in the domain.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import { createFetcherRegistry } from '@/adapters/fetchers';
import type { ActionResult } from './action-result';
import { ingestDueSources, ingestManualUrl } from './ingest';

export type { ActionResult } from './action-result';

/** Decision D5's escape hatch: a human pastes a URL the feeds never saw. */
export async function addManualUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const raw = String(formData.get('url') ?? '').trim();

  if (!raw) {
    return { ok: false, message: 'Paste a URL first.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: 'That does not look like a URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'Only http and https URLs can be fetched.' };
  }

  try {
    const registry = createFetcherRegistry();
    const report = await ingestManualUrl(getDb(), raw, registry.MANUAL);

    revalidatePath('/research');

    if (report.failed > 0) {
      return { ok: false, message: report.errors[0] ?? 'Could not read that page.' };
    }
    if (report.duplicates > 0 && report.stored === 0) {
      return { ok: true, message: 'Already in the research queue.' };
    }
    return {
      ok: true,
      message: `Added. ${report.claimsProposed} claim candidate(s) proposed for review.`,
    };
  } catch (error) {
    // §40: report the failure, do not pretend it worked.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not fetch that page: ${message}` };
  }
}

/** Polls every source whose interval has elapsed. */
export async function pollSources(): Promise<ActionResult> {
  try {
    const registry = createFetcherRegistry();
    const reports = await ingestDueSources(getDb(), (kind) => registry[kind]);

    revalidatePath('/research');

    if (reports.length === 0) {
      return { ok: true, message: 'No sources are due yet.' };
    }

    const stored = reports.reduce((sum, r) => sum + r.stored, 0);
    const duplicates = reports.reduce((sum, r) => sum + r.duplicates, 0);
    const failed = reports.filter((r) => r.failed > 0).length;

    return {
      ok: failed === 0,
      message:
        `Polled ${reports.length} source(s): ${stored} new, ` +
        `${duplicates} duplicate(s)` +
        (failed > 0 ? `, ${failed} source(s) failed — see System events.` : '.'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Poll failed: ${message}` };
  }
}

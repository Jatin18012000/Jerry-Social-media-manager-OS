'use server';

/**
 * Server actions for opportunities and the brief loop.
 *
 * These own the transaction boundary and revalidation. Every rule they appear
 * to enforce actually lives in the domain — an action that duplicated a rule
 * here would be a second place for it to drift.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { ContentState } from '@/domain/content-state';
import type { ContentFormat, Platform } from '@/domain/content';
import type { ActionResult } from './action-result';
import {
  EditRefusedError,
  advancePipeline,
  editContent,
  nextPipelineStep,
  verifyClaim,
} from './content';
import {
  buildBrief,
  createContentItem,
  createOpportunity,
  saveGeneration,
} from './opportunities';

export type { ActionResult } from './action-result';

function fail(error: unknown, prefix: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, message: `${prefix}: ${message}` };
}

/** Promotes a research item into a content opportunity (§12). */
export async function promoteResearch(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const researchItemId = Number(formData.get('researchItemId'));
  const title = String(formData.get('title') ?? '').trim();
  const thesis = String(formData.get('thesis') ?? '').trim();

  if (!Number.isInteger(researchItemId) || researchItemId <= 0) {
    return { ok: false, message: 'Pick a research item first.' };
  }
  if (!title) {
    return { ok: false, message: 'Give the opportunity a title.' };
  }

  try {
    const id = createOpportunity(getDb(), {
      title,
      ...(thesis ? { thesis } : {}),
      researchItemIds: [researchItemId],
    });
    revalidatePath('/research');
    revalidatePath('/opportunities');
    return {
      ok: true,
      message: 'Opportunity created.',
      redirectTo: `/opportunities/${id}`,
    };
  } catch (error) {
    return fail(error, 'Could not create the opportunity');
  }
}

/** Creates a platform variant of an opportunity (§21). */
export async function addVariant(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const opportunityId = Number(formData.get('opportunityId'));
  const platform = String(formData.get('platform') ?? '') as Platform;
  const format = String(formData.get('format') ?? '') as ContentFormat;

  try {
    const id = createContentItem(getDb(), {
      opportunityId,
      platform,
      format,
    });
    revalidatePath(`/opportunities/${opportunityId}`);
    return {
      ok: true,
      message: 'Variant created.',
      redirectTo: `/content/${id}`,
    };
  } catch (error) {
    return fail(error, 'Could not create the variant');
  }
}

/** Records a human's verification of a claim (§7.2). */
export async function submitClaimVerification(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const claimId = Number(formData.get('claimId'));
  const status = String(formData.get('status') ?? '') as
    | 'VERIFIED'
    | 'DISPUTED'
    | 'UNVERIFIABLE';
  const evidenceUrl = String(formData.get('evidenceUrl') ?? '').trim();
  const evidenceTier = String(formData.get('evidenceTier') ?? '').trim();
  const contentItemId = Number(formData.get('contentItemId'));

  try {
    verifyClaim(getDb(), claimId, {
      status,
      ...(evidenceUrl ? { evidenceUrl } : {}),
      ...(evidenceTier
        ? { evidenceTier: evidenceTier as 'PRIMARY' }
        : {}),
      verifiedBy: 'jatin',
    });
    revalidatePath(`/content/${contentItemId}`);
    return { ok: true, message: `Claim marked ${status}.` };
  } catch (error) {
    return fail(error, 'Could not record that');
  }
}

/** Composes the brief and moves the item to GENERATING (§13, D3). */
export async function composeBriefFor(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));

  try {
    buildBrief(getDb(), contentItemId, { actor: 'jatin' });
    revalidatePath(`/content/${contentItemId}`);
    return { ok: true, message: 'Brief ready — copy it and paste it in.' };
  } catch (error) {
    return fail(error, 'Could not build the brief');
  }
}

/**
 * Saves a pasted generation.
 *
 * Never rejects a paste for being unparseable — the raw text is persisted
 * regardless and the result says what still needs filling in (D3).
 */
export async function submitGeneration(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const briefId = Number(formData.get('briefId'));
  const rawResponse = String(formData.get('rawResponse') ?? '');
  const provider = String(formData.get('provider') ?? '').trim();

  if (!rawResponse.trim()) {
    return { ok: false, message: 'Paste the response first.' };
  }

  try {
    const result = saveGeneration(getDb(), {
      contentItemId,
      briefId,
      rawResponse,
      ...(provider ? { provider } : {}),
      actor: 'jatin',
    });

    revalidatePath(`/content/${contentItemId}`);

    if (!result.parsedOk) {
      return {
        ok: false,
        message:
          result.error ??
          'Saved, but the fields could not be read automatically.',
      };
    }

    return {
      ok: true,
      message:
        result.missing.length > 0
          ? `Saved. Still missing: ${result.missing.join(', ')}.`
          : 'Saved — all fields read.',
    };
  } catch (error) {
    return fail(error, 'Could not save that');
  }
}

/**
 * §23's Edit action, on the content fields themselves.
 *
 * Editing an approved item revokes the approval and cancels any pending
 * schedule — otherwise the approval would be of nothing in particular. The
 * result says so plainly rather than letting it happen quietly.
 */
export async function editContentFields(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));

  const field = (name: string): string | undefined => {
    const raw = formData.get(name);
    return raw === null ? undefined : String(raw);
  };

  try {
    const result = editContent(
      getDb(),
      contentItemId,
      {
        hook: field('hook'),
        body: field('body'),
        caption: field('caption'),
        cta: field('cta'),
        hashtags: field('hashtags'),
        altText: field('altText'),
      },
      { actor: 'jatin' },
    );

    revalidatePath(`/content/${contentItemId}`);
    revalidatePath('/review');
    revalidatePath('/schedule');

    return {
      ok: true,
      message: result.approvalRevoked
        ? 'Saved. This was approved, so the approval was revoked and any ' +
          'schedule cancelled — it needs approving again.'
        : 'Saved.',
    };
  } catch (error) {
    if (error instanceof EditRefusedError) {
      return { ok: false, message: error.message };
    }
    return fail(error, 'Could not save');
  }
}

/**
 * Advances a content item one step along the early pipeline.
 *
 * The transition itself, its guards and its audit event all belong to
 * `moveTo` — this only carries the operator's intent across the wire and
 * turns a domain refusal into something readable.
 *
 * The target is sent by the client and therefore not trusted:
 * `advancePipeline` accepts only the one step registered for the item's
 * current state, so a crafted request cannot use this to reach APPROVED or
 * SCHEDULED. Those keep their own guarded paths (§22).
 */
export async function advanceLifecycle(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const to = String(formData.get('to') ?? '') as ContentState;

  if (!Number.isInteger(contentItemId)) {
    return { ok: false, message: 'Missing content item.' };
  }

  try {
    const db = getDb();
    const reached = advancePipeline(db, contentItemId, to, { actor: 'jatin' });
    const next = nextPipelineStep(db, contentItemId);

    revalidatePath(`/content/${contentItemId}`);
    revalidatePath('/review');
    revalidatePath('/');

    return {
      ok: true,
      message:
        next === null
          ? `Now ${reached}.`
          : `Now ${reached}. Next: ${next.to}.`,
    };
  } catch (error) {
    // A guard refusal is the interesting case — an unverified claim blocking
    // STRATEGY_READY is information, not a failure to hide (§16).
    return fail(error, 'Could not advance');
  }
}

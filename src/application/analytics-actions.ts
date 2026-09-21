'use server';

/**
 * Server actions for analytics capture — decision D4.
 *
 * The flow is deliberately two-step: read, then confirm. Nothing is written
 * until a person has seen the numbers the parser produced, because §40
 * forbids fabricated metrics and a confidently-wrong OCR read is exactly that.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { MetricKey } from '@/domain/metrics-parse';
import type { ActionResult } from './action-result';
import { previewReading, saveReading } from './analytics';

export type { ActionResult } from './action-result';

export interface PreviewResult extends ActionResult {
  readonly contentItemId?: number;
  readonly metrics?: Partial<Record<MetricKey, number>>;
  readonly confidence?: number;
  readonly unreadable?: readonly string[];
  readonly rawText?: string;
}

function fail(error: unknown, prefix: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, message: `${prefix}: ${message}` };
}

/** Step one: read the pasted text and show what was understood. */
export async function readMetrics(
  _prev: PreviewResult | null,
  formData: FormData,
): Promise<PreviewResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const rawText = String(formData.get('rawText') ?? '');

  if (!rawText.trim()) {
    return { ok: false, message: 'Paste the text from the Insights panel.' };
  }

  try {
    const preview = previewReading(getDb(), contentItemId, rawText);
    const found = Object.keys(preview.parsed.metrics).length;

    if (found === 0) {
      return {
        ok: false,
        message:
          'No metrics recognised in that text. Check it is the Insights ' +
          'panel, or enter the numbers by hand below.',
        contentItemId,
        metrics: {},
        rawText,
      };
    }

    return {
      ok: true,
      message: preview.needsConfirmation
        ? `Read ${found} metric(s), but not confidently. Check each one before saving.`
        : `Read ${found} metric(s). Check them, then save.`,
      contentItemId,
      metrics: preview.parsed.metrics,
      confidence: preview.parsed.confidence,
      unreadable: preview.parsed.unreadable,
      rawText,
    };
  } catch (error) {
    return fail(error, 'Could not read that');
  }
}

const METRIC_FIELDS: MetricKey[] = [
  'impressions',
  'reach',
  'views',
  'likes',
  'comments',
  'saves',
  'shares',
  'profileVisits',
  'follows',
  'clicks',
];

/**
 * Step two: store what the human confirmed.
 *
 * A blank field is left out entirely rather than stored as zero — §26 says
 * availability varies by platform and §40 forbids inventing the difference.
 */
export async function saveMetrics(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const contentItemId = Number(formData.get('contentItemId'));
  const rawText = String(formData.get('rawText') ?? '');
  const confidenceRaw = String(formData.get('confidence') ?? '');

  const metrics: Partial<Record<MetricKey, number>> = {};

  for (const field of METRIC_FIELDS) {
    const raw = String(formData.get(field) ?? '').trim();
    if (raw === '') continue;

    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, message: `"${raw}" is not a valid ${field} value.` };
    }
    metrics[field] = Math.round(value);
  }

  if (Object.keys(metrics).length === 0) {
    return { ok: false, message: 'Fill in at least one metric.' };
  }

  try {
    saveReading(getDb(), {
      contentItemId,
      metrics,
      source: rawText ? 'OCR' : 'MANUAL',
      ...(rawText ? { rawText } : {}),
      ...(confidenceRaw ? { confidence: Number(confidenceRaw) } : {}),
      confirmedBy: 'jatin',
    });

    revalidatePath('/analytics');
    revalidatePath(`/content/${contentItemId}`);

    return {
      ok: true,
      message: `Saved ${Object.keys(metrics).length} metric(s).`,
    };
  } catch (error) {
    return fail(error, 'Could not save');
  }
}

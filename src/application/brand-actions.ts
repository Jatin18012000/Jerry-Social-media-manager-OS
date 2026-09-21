'use server';

/**
 * Saving the brand configuration — PRD §8, §19, §20.
 *
 * §4 assigns brand and content strategy to ChatGPT and §5 forbids this
 * codebase from setting it. So this stores and versions what Jatin and
 * ChatGPT decide; it does not propose any of it.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import { PLACEHOLDER_BRAND } from '@/domain/brand';
import type { ActionResult } from './action-result';
import { saveBrandVersion } from './brand';

export type { ActionResult } from './action-result';

/** One item per line, blanks dropped. */
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Saves a new version of the brand configuration and makes it active.
 *
 * A new row rather than an update: §20 wants these centralised and versioned,
 * and versioning is what lets the learning engine later answer "did
 * engagement change after we changed the voice?".
 */
export async function saveBrand(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const traits = lines(formData.get('traits'));

  if (traits.length === 0) {
    return { ok: false, message: 'Give the voice at least one trait.' };
  }

  const candidate = {
    ...PLACEHOLDER_BRAND,
    brandName: String(formData.get('brandName') ?? '').trim(),
    positioning: String(formData.get('positioning') ?? '').trim(),
    audiencePrimary: String(formData.get('audiencePrimary') ?? '').trim(),
    audienceSecondary: String(formData.get('audienceSecondary') ?? '').trim(),
    languagePolicy: String(formData.get('languagePolicy') ?? '').trim(),
    voice: {
      traits,
      does: lines(formData.get('does')),
      avoids: lines(formData.get('avoids')),
      exampleLines: lines(formData.get('exampleLines')),
    },
    character: null,
    designSystem: null,
    // The whole point of this form: this is no longer a placeholder.
    isPlaceholder: false,
  };

  try {
    const saved = saveBrandVersion(getDb(), candidate, {
      note: String(formData.get('note') ?? ''),
    });

    revalidatePath('/');
    revalidatePath('/settings/brand');

    return {
      ok: true,
      message:
        `Saved as version ${saved.version}. New briefs will use it; briefs ` +
        `already composed keep the voice they were written with.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not save: ${message}` };
  }
}

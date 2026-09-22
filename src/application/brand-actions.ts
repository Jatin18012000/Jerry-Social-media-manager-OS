'use server';

/**
 * Saving and activating the brand configuration — PRD §8, §19, §20, §4, §5.
 *
 * §4 assigns brand and content strategy to ChatGPT and Jatin, and §5 forbids
 * this codebase from setting it. This stores and versions what they decide;
 * it proposes none of it, and it supplies no defaults for any of it.
 */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import type { ActionResult } from './action-result';
import { BrandError, activateBrandVersion, saveBrandDraft } from './brand';

export type { ActionResult } from './action-result';

/** One item per line, blanks dropped. */
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

/**
 * Saves a new brand version as an inactive draft.
 *
 * Every field is read from the form explicitly. There is deliberately no
 * spread of the placeholder underneath: a field the form does not supply must
 * fail validation rather than quietly inherit placeholder content, which is
 * precisely how a brand voice nobody wrote once came into use.
 *
 * Saving does not activate. Nothing here changes what a brief is written in.
 */
export async function saveBrand(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const candidate = {
    brandName: field(formData, 'brandName'),
    positioning: field(formData, 'positioning'),
    audiencePrimary: field(formData, 'audiencePrimary'),
    audienceSecondary: field(formData, 'audienceSecondary'),
    languagePolicy: field(formData, 'languagePolicy'),
    voice: {
      traits: lines(formData.get('traits')),
      does: lines(formData.get('does')),
      avoids: lines(formData.get('avoids')),
      exampleLines: lines(formData.get('exampleLines')),
    },
    character: null,
    designSystem: null,
    isPlaceholder: false as const,
  };

  try {
    const saved = saveBrandDraft(getDb(), candidate, {
      note: field(formData, 'note'),
    });

    revalidatePath('/settings/brand');

    return {
      ok: true,
      message:
        `Saved as draft version ${saved.version}. It is not in use yet — ` +
        `activate it below when you are satisfied with it.`,
    };
  } catch (error) {
    if (error instanceof BrandError) {
      return { ok: false, message: `Not saved: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not save: ${message}` };
  }
}

/**
 * Puts a saved draft into use.
 *
 * Separate from saving, and requires a named person plus an explicit
 * confirmation. §4 makes this a human decision and an unattributed one is not
 * a human decision — it is a side effect.
 */
export async function activateBrand(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const version = Number(formData.get('version'));
  const actor = field(formData, 'actor');

  if (!Number.isInteger(version)) {
    return { ok: false, message: 'Pick a version to activate.' };
  }

  if (!actor) {
    return {
      ok: false,
      message:
        'Type your name to activate. This is recorded, because a brand ' +
        'voice in use with nobody behind it is the failure this guards ' +
        'against.',
    };
  }

  try {
    const activated = activateBrandVersion(getDb(), {
      version,
      actor,
      confirm: true,
    });

    revalidatePath('/');
    revalidatePath('/settings/brand');
    revalidatePath('/system');

    return {
      ok: true,
      message:
        `Version ${activated.version} is now the active brand voice. New ` +
        `briefs will use it; briefs already composed keep the voice they ` +
        `were written with.`,
    };
  } catch (error) {
    if (error instanceof BrandError) {
      return { ok: false, message: `Not activated: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not activate: ${message}` };
  }
}

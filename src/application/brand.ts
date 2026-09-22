/**
 * Brand configuration storage — PRD §8, §19, §20, §4, §5.
 *
 * §4 assigns brand and content strategy to ChatGPT and Jatin, and §5 forbids
 * this codebase from setting it. This module stores and versions what they
 * decide; it proposes none of it.
 *
 * Saving and activating are deliberately two separate acts.
 *
 * A production brand voice was once created here by accident — a verification
 * run submitted the settings form, the payload inherited placeholder content
 * field by field, and it was stored flagged as real. Every brief afterwards
 * was written in a voice nobody authored, with the "brand voice not yet
 * defined" warning silently suppressed, which is §57 Risk 1 firing with its
 * own alarm disabled and §5 violated at the same time.
 *
 * Three things follow from that, and they are the reason this module looks
 * the way it does:
 *
 *   Saving never activates. A draft is inert; it changes no brief.
 *   Activating requires a named human and an explicit confirmation. It
 *   cannot be a side effect of submitting a form.
 *   A production brand is validated against `productionBrandSchema`, which
 *   has no defaults, so nothing can be inherited from anywhere.
 */

import { desc, eq } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { brandConfig, systemEvents } from '@/db/schema';
import {
  type BrandConfig,
  safeParseBrandConfig,
  safeParseProductionBrand,
} from '@/domain/brand';

export class BrandError extends Error {}

export interface SavedBrand {
  readonly version: number;
  readonly config: BrandConfig;
  /** Always false on save. Activation is a separate, confirmed act. */
  readonly active: boolean;
}

/**
 * Stores a new brand version as an inactive draft.
 *
 * A new row rather than an update: §20 wants the brand versioned, and
 * versioning is what lets the learning engine later answer "did engagement
 * change after the voice changed?". Overwriting would destroy that evidence.
 *
 * Never activates. A draft cannot change what any brief is written in, so
 * saving is safe in a way activating is not.
 */
export function saveBrandDraft(
  db: DB,
  candidate: unknown,
  opts: { note?: string; now?: Date } = {},
): SavedBrand {
  const asPlaceholder =
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { isPlaceholder?: unknown }).isPlaceholder === true;

  // A production brand is held to the strict schema. Nothing may default.
  const parsed = asPlaceholder
    ? safeParseBrandConfig(candidate)
    : safeParseProductionBrand(candidate);

  if (!parsed.ok) throw new BrandError(parsed.error);

  const now = (opts.now ?? new Date()).getTime();

  const latest = db
    .select({ version: brandConfig.version })
    .from(brandConfig)
    .orderBy(desc(brandConfig.version))
    .get();

  const version = (latest?.version ?? 0) + 1;

  db.insert(brandConfig)
    .values({
      version,
      active: false,
      isPlaceholder: parsed.config.isPlaceholder,
      payloadJson: JSON.stringify(parsed.config),
      note: opts.note?.trim() || null,
      activatedBy: null,
      activatedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { version, config: parsed.config, active: false };
}

export interface ActivationRequest {
  readonly version: number;
  /** The human taking responsibility. §4 makes this a person's decision. */
  readonly actor: string;
  /**
   * Explicit intent, separate from the act of submitting a form.
   *
   * A boolean rather than a truthy value by accident: this is the single
   * argument that turns an inert draft into the voice every brief is written
   * in, and it should be impossible to supply it without meaning to.
   */
  readonly confirm: true;
}

/**
 * Makes one stored version the active brand voice.
 *
 * This is the only path by which a real brand voice can come into use, and
 * the only place `active` is ever set true.
 */
export function activateBrandVersion(
  db: DB,
  request: ActivationRequest,
  opts: { now?: Date } = {},
): SavedBrand {
  const actor = request.actor?.trim();

  if (!actor) {
    throw new BrandError(
      'Activating a brand voice requires the name of the person doing it. ' +
        '§4 makes this a human decision, and an unattributed one is not.',
    );
  }

  if (request.confirm !== true) {
    throw new BrandError(
      'Activation must be confirmed explicitly. Saving a draft does not put ' +
        'a voice into use.',
    );
  }

  const row = db
    .select()
    .from(brandConfig)
    .where(eq(brandConfig.version, request.version))
    .get();

  if (!row) throw new BrandError(`No brand version ${request.version}.`);

  // Re-validated at activation, not only at save. A row could have been
  // written by something other than saveBrandDraft, and this is the gate that
  // decides what every brief is written in.
  const payload: unknown = JSON.parse(row.payloadJson);
  const parsed =
    row.isPlaceholder === true
      ? safeParseBrandConfig(payload)
      : safeParseProductionBrand(payload);

  if (!parsed.ok) {
    throw new BrandError(
      `Version ${request.version} is not a valid brand configuration and ` +
        `will not be activated: ${parsed.error}`,
    );
  }

  const now = (opts.now ?? new Date()).getTime();

  db.transaction((tx) => {
    // Exactly one active version, always. Two would make "the brand voice"
    // ambiguous and activeBrand() would silently pick one.
    tx.update(brandConfig)
      .set({ active: false, updatedAt: now })
      .where(eq(brandConfig.active, true))
      .run();

    tx.update(brandConfig)
      .set({
        active: true,
        activatedBy: actor,
        activatedAt: now,
        updatedAt: now,
      })
      .where(eq(brandConfig.version, request.version))
      .run();

    // §43. Auditable: which version, who, when. Inside the transaction so a
    // brand cannot become active without the record of who made it so.
    tx.insert(systemEvents)
      .values({
        kind: 'brand_config.activated',
        severity: 'INFO',
        payload: JSON.stringify({
          version: request.version,
          actor,
          isPlaceholder: parsed.config.isPlaceholder,
          activatedAt: now,
        }),
        createdAt: now,
      })
      .run();
  });

  return { version: request.version, config: parsed.config, active: true };
}

export interface BrandVersionRow {
  readonly version: number;
  readonly active: boolean;
  readonly isPlaceholder: boolean;
  readonly note: string | null;
  readonly activatedBy: string | null;
  readonly activatedAt: number | null;
  readonly createdAt: number;
}

export function brandVersions(db: DB, limit = 10): BrandVersionRow[] {
  return db
    .select({
      version: brandConfig.version,
      active: brandConfig.active,
      isPlaceholder: brandConfig.isPlaceholder,
      note: brandConfig.note,
      activatedBy: brandConfig.activatedBy,
      activatedAt: brandConfig.activatedAt,
      createdAt: brandConfig.createdAt,
    })
    .from(brandConfig)
    .orderBy(desc(brandConfig.version))
    .limit(limit)
    .all();
}

/** Provenance of the voice currently in use, for display. */
export interface ActiveBrandProvenance {
  readonly version: number | null;
  readonly isPlaceholder: boolean;
  readonly activatedBy: string | null;
  readonly activatedAt: number | null;
}

export function activeBrandProvenance(db: DB): ActiveBrandProvenance {
  const row = db
    .select({
      version: brandConfig.version,
      isPlaceholder: brandConfig.isPlaceholder,
      activatedBy: brandConfig.activatedBy,
      activatedAt: brandConfig.activatedAt,
    })
    .from(brandConfig)
    .where(eq(brandConfig.active, true))
    .orderBy(desc(brandConfig.version))
    .get();

  // No active row means the placeholder is in use — the correct
  // BRAND VOICE UNDEFINED state, not a missing record.
  if (!row) {
    return {
      version: null,
      isPlaceholder: true,
      activatedBy: null,
      activatedAt: null,
    };
  }

  return row;
}

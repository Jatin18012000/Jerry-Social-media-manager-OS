/**
 * Content opportunities and the brief loop — PRD §12, §13, §17, decision D3.
 *
 * §12 is explicit that the fundamental unit is the Content Opportunity, not
 * the post: one research event fans out into several platform-native pieces
 * that share the same underlying facts (§21).
 *
 * The generation half of this module implements the loop D3 chose:
 *
 *     verified claims + brand voice  ->  brief  ->  [human pastes into
 *     Claude/Gemini]  ->  raw response persisted  ->  parsed into fields
 *
 * The raw response is written before parsing is attempted. Under D3 that text
 * cost the human real effort and must survive a parser bug.
 */

import { desc, eq, inArray } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  brandConfig,
  briefs,
  claims,
  contentItemSources,
  contentItems,
  contentOpportunities,
  contentPillars,
  generations,
  learningFindings,
  opportunityResearch,
  researchItems,
  sources,
  systemEvents,
} from '@/db/schema';
import { PLACEHOLDER_BRAND, safeParseBrandConfig } from '@/domain/brand';
import { type BriefClaim, composeBrief } from '@/domain/brief';
import type { CharacterMode, ContentFormat, Language, Platform } from '@/domain/content';
import { supportsFormat } from '@/domain/content';
import { parseGeneration } from '@/domain/generation-parse';
import { attachClaims, moveTo } from './content';

/** The active brand config, or the placeholder if none is set (§8, §20). */
export function activeBrand(db: DB) {
  const row = db
    .select()
    .from(brandConfig)
    .where(eq(brandConfig.active, true))
    .orderBy(desc(brandConfig.version))
    .get();

  if (!row) return PLACEHOLDER_BRAND;

  const parsed = safeParseBrandConfig(JSON.parse(row.payloadJson));
  if (!parsed.ok) {
    // A malformed config must not silently become "no voice at all" — that
    // would quietly produce generic content (§57 Risk 1) with no warning.
    db.insert(systemEvents)
      .values({
        kind: 'brand_config.invalid',
        severity: 'ERROR',
        payload: JSON.stringify({ version: row.version, error: parsed.error }),
      })
      .run();
    return PLACEHOLDER_BRAND;
  }

  return parsed.config;
}

export interface CreateOpportunityInput {
  readonly title: string;
  readonly thesis?: string;
  readonly angle?: string;
  readonly pillarId?: number;
  readonly researchItemIds: readonly number[];
  readonly windowExpiresAt?: Date;
  readonly now?: Date;
}

/**
 * Promotes one or more research items into a content opportunity.
 *
 * The research items are marked PROMOTED so the triage queue does not keep
 * offering work already picked up.
 */
export function createOpportunity(
  db: DB,
  input: CreateOpportunityInput,
): number {
  const now = (input.now ?? new Date()).getTime();

  return db.transaction((tx) => {
    const opportunity = tx
      .insert(contentOpportunities)
      .values({
        title: input.title,
        thesis: input.thesis ?? null,
        angle: input.angle ?? null,
        pillarId: input.pillarId ?? null,
        status: 'OPEN',
        windowExpiresAt: input.windowExpiresAt?.getTime() ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: contentOpportunities.id })
      .get();

    for (const researchItemId of input.researchItemIds) {
      tx.insert(opportunityResearch)
        .values({ opportunityId: opportunity.id, researchItemId })
        .run();

      tx.update(researchItems)
        .set({ status: 'PROMOTED', updatedAt: now })
        .where(eq(researchItems.id, researchItemId))
        .run();
    }

    return opportunity.id;
  });
}

export interface CreateContentItemInput {
  readonly opportunityId: number;
  readonly platform: Platform;
  readonly format: ContentFormat;
  readonly language?: Language;
  readonly characterMode?: CharacterMode;
  readonly topic?: string;
  readonly now?: Date;
}

/**
 * Creates a platform variant of an opportunity, carrying over its claims.
 *
 * Provenance is inherited automatically: §21 says the framing differs between
 * platforms but the underlying facts do not, so a variant must rest on the
 * same claims as its siblings rather than being re-sourced by hand.
 */
export function createContentItem(
  db: DB,
  input: CreateContentItemInput,
): number {
  if (!supportsFormat(input.platform, input.format)) {
    throw new Error(
      `${input.platform} does not support format ${input.format} (§11).`,
    );
  }

  const now = (input.now ?? new Date()).getTime();

  const opportunity = db
    .select()
    .from(contentOpportunities)
    .where(eq(contentOpportunities.id, input.opportunityId))
    .get();

  if (!opportunity) {
    throw new Error(`No opportunity ${input.opportunityId}`);
  }

  const contentItemId = db
    .insert(contentItems)
    .values({
      opportunityId: input.opportunityId,
      platform: input.platform,
      format: input.format,
      language: input.language ?? 'EN',
      characterMode: input.characterMode ?? 'HUMAN',
      pillarId: opportunity.pillarId,
      topic: input.topic ?? opportunity.title,
      state: 'IDEA',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: contentItems.id })
    .get().id;

  const claimIds = db
    .select({ id: claims.id })
    .from(opportunityResearch)
    .innerJoin(claims, eq(claims.researchItemId, opportunityResearch.researchItemId))
    .where(eq(opportunityResearch.opportunityId, input.opportunityId))
    .all()
    .map((row) => row.id);

  attachClaims(db, contentItemId, claimIds);

  db.update(contentOpportunities)
    .set({ status: 'IN_PROGRESS', updatedAt: now })
    .where(eq(contentOpportunities.id, input.opportunityId))
    .run();

  return contentItemId;
}

/**
 * The claims this content item rests on, with their sources — §16.
 *
 * Scoped through content_item_sources, so a brief only ever carries the
 * provenance actually attached to that item.
 */
export function scopedClaims(db: DB, contentItemId: number): BriefClaim[] {
  return db
    .select({
      text: claims.text,
      claimType: claims.claimType,
      verificationStatus: claims.verificationStatus,
      evidenceUrl: claims.evidenceUrl,
      evidenceTier: claims.evidenceTier,
      sourceName: sources.name,
    })
    .from(contentItemSources)
    .innerJoin(claims, eq(claims.id, contentItemSources.claimId))
    .innerJoin(researchItems, eq(researchItems.id, claims.researchItemId))
    .innerJoin(sources, eq(sources.id, researchItems.sourceId))
    .where(eq(contentItemSources.contentItemId, contentItemId))
    .all();
}

/** Same as scopedClaims, plus the ids the verification form needs. */
export function scopedClaimsWithIds(db: DB, contentItemId: number) {
  return db
    .select({
      id: claims.id,
      text: claims.text,
      claimType: claims.claimType,
      verificationStatus: claims.verificationStatus,
      evidenceUrl: claims.evidenceUrl,
      evidenceTier: claims.evidenceTier,
      sourceName: sources.name,
    })
    .from(contentItemSources)
    .innerJoin(claims, eq(claims.id, contentItemSources.claimId))
    .innerJoin(researchItems, eq(researchItems.id, claims.researchItemId))
    .innerJoin(sources, eq(sources.id, researchItems.sourceId))
    .where(eq(contentItemSources.contentItemId, contentItemId))
    .all();
}

export interface BuildBriefResult {
  readonly briefId: number;
  readonly promptText: string;
}

/**
 * Builds and persists the brief for a content item, moving it to GENERATING.
 *
 * The state move and the brief row are separate writes deliberately: the
 * brief is durable even if the transition is later reverted, so a human who
 * has already pasted it into Claude is not left holding an orphan.
 */
export function buildBrief(
  db: DB,
  contentItemId: number,
  opts: { actor?: string; now?: Date } = {},
): BuildBriefResult {
  const item = db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .get();

  if (!item) throw new Error(`No content item ${contentItemId}`);

  const opportunity = item.opportunityId
    ? db
        .select()
        .from(contentOpportunities)
        .where(eq(contentOpportunities.id, item.opportunityId))
        .get()
    : undefined;

  const pillar = item.pillarId
    ? db
        .select()
        .from(contentPillars)
        .where(eq(contentPillars.id, item.pillarId))
        .get()
    : undefined;

  const brand = activeBrand(db);
  const scoped = scopedClaims(db, contentItemId);

  // §29: only findings the learning engine considers sufficient reach a brief.
  const findings = db
    .select({
      summary: learningFindings.summary,
      sampleSize: learningFindings.sampleSize,
      confidence: learningFindings.confidence,
    })
    .from(learningFindings)
    .where(inArray(learningFindings.status, ['SUPPORTED', 'HYPOTHESIS']))
    .orderBy(desc(learningFindings.computedAt))
    .limit(5)
    .all();

  const promptText = composeBrief({
    brand,
    platform: item.platform,
    format: item.format,
    language: item.language,
    characterMode: item.characterMode,
    pillarName: pillar?.name ?? null,
    opportunityTitle: opportunity?.title ?? item.topic ?? 'Untitled',
    opportunityThesis: opportunity?.thesis ?? null,
    angle: opportunity?.angle ?? null,
    claims: scoped,
    findings,
  });

  const now = (opts.now ?? new Date()).getTime();

  const briefId = db
    .insert(briefs)
    .values({
      contentItemId,
      promptText,
      brandConfigId: null,
      providerHint: 'MANUAL',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: briefs.id })
    .get().id;

  // Walk to GENERATING only from a state that legally reaches it.
  if (item.state === 'STRATEGY_READY' || item.state === 'NEEDS_REVISION') {
    moveTo(db, contentItemId, 'GENERATING', {
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      note: 'brief composed',
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  return { briefId, promptText };
}

export interface SaveGenerationResult {
  readonly generationId: number;
  readonly parsedOk: boolean;
  readonly missing: readonly string[];
  readonly error?: string;
}

/**
 * Persists a pasted generation and applies whatever parsed.
 *
 * The raw response is written first, unconditionally. Parsing happens after,
 * and a failure degrades the result rather than losing the paste.
 */
export function saveGeneration(
  db: DB,
  input: {
    contentItemId: number;
    briefId: number;
    rawResponse: string;
    provider?: string;
    model?: string;
    actor?: string;
    now?: Date;
  },
): SaveGenerationResult {
  const now = (input.now ?? new Date()).getTime();

  // Written before parsing is attempted (D3).
  const generationId = db
    .insert(generations)
    .values({
      briefId: input.briefId,
      contentItemId: input.contentItemId,
      mode: 'MANUAL',
      provider: input.provider ?? null,
      model: input.model ?? null,
      rawResponse: input.rawResponse,
      parsedOk: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: generations.id })
    .get().id;

  const result = parseGeneration(input.rawResponse);

  db.update(generations)
    .set({
      parsedOk: result.ok,
      parseError: result.error ?? null,
      updatedAt: now,
    })
    .where(eq(generations.id, generationId))
    .run();

  const patch: Partial<typeof contentItems.$inferInsert> = {};
  if (result.parsed.hook !== null) patch.hook = result.parsed.hook;
  if (result.parsed.body !== null) patch.body = result.parsed.body;
  if (result.parsed.caption !== null) patch.caption = result.parsed.caption;
  if (result.parsed.cta !== null) patch.cta = result.parsed.cta;
  if (result.parsed.altText !== null) patch.altText = result.parsed.altText;
  if (result.parsed.hashtags.length > 0) {
    patch.hashtags = result.parsed.hashtags.join(' ');
  }

  const state = db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get()?.state;

  if (state === 'GENERATING') {
    moveTo(db, input.contentItemId, 'QA', {
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      note: result.ok
        ? `parsed via ${result.strategy}`
        : 'pasted but not parsed — fields need completing by hand',
      patch,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
  } else if (Object.keys(patch).length > 0) {
    db.update(contentItems)
      .set({ ...patch, updatedAt: now })
      .where(eq(contentItems.id, input.contentItemId))
      .run();
  }

  return {
    generationId,
    parsedOk: result.ok,
    missing: result.missing,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** Opportunities still worth acting on, newest and highest priority first. */
export function openOpportunities(db: DB, now: Date = new Date()) {
  return db
    .select()
    .from(contentOpportunities)
    .where(inArray(contentOpportunities.status, ['OPEN', 'IN_PROGRESS']))
    .orderBy(
      desc(contentOpportunities.priority),
      desc(contentOpportunities.createdAt),
    )
    .all()
    .map((row) => ({
      ...row,
      // §12: AI news decays. An expired window should say so rather than
      // sitting in the queue looking actionable.
      expired:
        row.windowExpiresAt !== null && row.windowExpiresAt < now.getTime(),
    }));
}

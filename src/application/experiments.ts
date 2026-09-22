/**
 * Pre-registered experiments — PRD §30, §55.
 *
 * §29 caps observational analysis at HYPOTHESIS. This module is the only
 * route past it, and the ordering is the whole mechanism: the terms are fixed,
 * then the posts go out, then the verdict is computed on those terms and no
 * others.
 *
 * The domain (`src/domain/experiment.ts`) owns every rule. This layer owns
 * transactions, the guards that need to see other rows — an item already in a
 * running experiment, a content item that was never published — and the link
 * into `learning_findings`.
 *
 * On scope (§54, §55): §55 puts experiments in V2 and §54 warns against
 * building V2 inside V1. This was built on Jatin's explicit instruction after
 * that conflict was raised. It is deliberately two-armed and manually
 * assigned: no traffic splitting, no sequential testing, no multi-arm
 * correction. Those are the parts that need volume this account does not have.
 *
 * SHELVED for the initial launch phase by product decision. `EXPERIMENTS_MODE`
 * gates the two entry points — creating and starting — in this layer rather
 * than in the UI, so no route, script or action can get past it. Everything
 * else stays compiled, tested and reachable: the mode gates behaviour, not
 * compilation, and nothing here becomes dead code.
 *
 * What shelving does *not* touch: §29's ceiling. Observational findings still
 * stop at HYPOTHESIS and `promoteWithExperiment` is still the only route to
 * SUPPORTED. With experiments shelved that route is simply not exercised,
 * which is the correct reading of "do not claim causal conclusions from
 * observational data" — the bar is unchanged, not lowered.
 */

import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  analyticsSnapshots,
  contentExperiments,
  contentItems,
  experiments,
  learningFindings,
  systemEvents,
} from '@/db/schema';
import {
  type Arm,
  type Conclusion,
  type PreRegistration,
  type PreRegistrationInput,
  ExperimentError,
  armFor,
  blocksConclusion,
  canTransition,
  concludeExperiment as concludeInDomain,
  decodeArms,
  encodeArms,
  findingFor,
  mayAssign,
  validatePreRegistration,
} from '@/domain/experiment';
import {
  engagementRate,
  followsPerThousandImpressions,
} from '@/domain/metrics-parse';
import { experimentsShelved, loadEnv } from '@/config/env';
import { METRICS, type MetricName } from './learning';

export { ExperimentError };

/**
 * Refuses the two acts that would start collecting experimental data.
 *
 * Reading and concluding are deliberately *not* gated: an experiment that was
 * already running when the mode changed must still be readable and closable,
 * and hiding it would strand real data behind a configuration flag.
 */
function assertExperimentsActive(opts: { shelved?: boolean } = {}): void {
  const shelved = opts.shelved ?? experimentsShelved(loadEnv());
  if (!shelved) return;

  throw new ExperimentError(
    'Experiments are shelved for the initial launch phase. The first ' +
      'content cycle observes, measures and forms hypotheses rather than ' +
      'running controlled tests. Set EXPERIMENTS_MODE=ACTIVE to re-enable ' +
      'them — nothing has been deleted.',
  );
}

/** States in which a content item has actually been measured. */
const MEASURABLE_STATES = ['PUBLISHED', 'ANALYZING', 'LEARNED'] as const;

function row(db: DB, id: number) {
  const found = db
    .select()
    .from(experiments)
    .where(eq(experiments.id, id))
    .get();
  if (!found) throw new ExperimentError(`No experiment ${id}.`);
  return found;
}

/** Rebuilds the pre-registration from storage. */
function preRegistrationOf(
  record: typeof experiments.$inferSelect,
): PreRegistration {
  const arms = decodeArms(record.variantDefinition);
  return {
    hypothesis: record.hypothesis,
    metric: record.metric,
    control: arms.control,
    treatment: arms.treatment,
    minSampleSize: record.minSampleSize,
  };
}

// ---------------------------------------------------------------------------
// Creating and starting
// ---------------------------------------------------------------------------

export interface CreateResult {
  readonly ok: boolean;
  readonly id?: number;
  readonly errors?: readonly string[];
}

/**
 * Registers an experiment as a DRAFT.
 *
 * Validated at creation rather than at start, so an experiment cannot sit in
 * the list looking ready when it could never be run.
 */
export function createExperiment(
  db: DB,
  input: PreRegistrationInput,
  opts: { now?: Date; shelved?: boolean } = {},
): CreateResult {
  assertExperimentsActive(opts);

  const now = opts.now ?? new Date();
  const validated = validatePreRegistration(input, Object.keys(METRICS));

  if (!validated.ok) return { ok: false, errors: validated.errors };

  const pre = validated.value;
  const id = db
    .insert(experiments)
    .values({
      hypothesis: pre.hypothesis,
      metric: pre.metric,
      variantDefinition: encodeArms(pre),
      minSampleSize: pre.minSampleSize,
      status: 'DRAFT',
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    })
    .returning({ id: experiments.id })
    .get().id;

  return { ok: true, id };
}

/**
 * Starts an experiment, freezing its terms.
 *
 * After this there is no edit path in the system: the pre-registration is
 * written once at creation and read thereafter. An experiment whose metric
 * can be changed once the numbers arrive pre-registers nothing.
 */
export function startExperiment(
  db: DB,
  id: number,
  opts: { now?: Date; shelved?: boolean } = {},
): void {
  assertExperimentsActive(opts);

  const now = opts.now ?? new Date();
  const record = row(db, id);

  if (!canTransition(record.status, 'RUNNING')) {
    throw new ExperimentError(
      `An experiment that is ${record.status} cannot be started.`,
    );
  }

  // Proves the stored terms are readable before any data is gathered against
  // them, rather than discovering it at conclusion time.
  preRegistrationOf(record);

  db.update(experiments)
    .set({ status: 'RUNNING', startAt: now.getTime(), updatedAt: now.getTime() })
    .where(eq(experiments.id, id))
    .run();

  db.insert(systemEvents)
    .values({
      kind: 'experiment.started',
      severity: 'INFO',
      payload: JSON.stringify({ experimentId: id, metric: record.metric }),
    })
    .run();
}

export function abandonExperiment(
  db: DB,
  id: number,
  reason: string,
  opts: { now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  const record = row(db, id);

  if (!canTransition(record.status, 'ABANDONED')) {
    throw new ExperimentError(
      `An experiment that is ${record.status} cannot be abandoned.`,
    );
  }

  // No verdict. An abandoned experiment produced no result, and recording one
  // would be indistinguishable from an inconclusive test that actually ran.
  db.update(experiments)
    .set({
      status: 'ABANDONED',
      endAt: now.getTime(),
      result: reason.trim() || 'Abandoned without a reason given.',
      updatedAt: now.getTime(),
    })
    .where(eq(experiments.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Assigns a content item to one arm.
 *
 * Four refusals, each protecting the comparison:
 *
 *   The experiment must be RUNNING (domain rule 1 — terms before data).
 *   The arm must be one of the two registered names, so a typo cannot create
 *   a third arm nobody registered.
 *   An item may be in at most one *running* experiment. With a handful of
 *   posts a week, two concurrent experiments over the same items confound
 *   both, and neither result would mean anything.
 *   An item already assigned to this experiment is not reassigned. Moving an
 *   item between arms after it has been measured is choosing where to put a
 *   data point once its value is known.
 *   An item that has already been measured cannot join at all. Its value is
 *   known, so choosing to enrol it is choosing a data point by its result —
 *   the same manoeuvre as stopping early, performed at the other end.
 */
export function assignVariant(
  db: DB,
  input: { experimentId: number; contentItemId: number; variant: string },
): void {
  const record = row(db, input.experimentId);

  if (!mayAssign(record.status)) {
    throw new ExperimentError(
      `Experiment ${input.experimentId} is ${record.status}, so it is not ` +
        `taking assignments. Terms are fixed before data, and data stops at ` +
        `the verdict.`,
    );
  }

  const pre = preRegistrationOf(record);
  const arm = armFor({ control: pre.control, treatment: pre.treatment }, input.variant);
  if (!arm) {
    throw new ExperimentError(
      `"${input.variant}" is not an arm of this experiment. ` +
        `It registered "${pre.control.name}" and "${pre.treatment.name}".`,
    );
  }

  const item = db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(eq(contentItems.id, input.contentItemId))
    .get();
  if (!item) {
    throw new ExperimentError(`No content item ${input.contentItemId}.`);
  }

  const measured = db
    .select({ id: analyticsSnapshots.id })
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.contentItemId, input.contentItemId))
    .get();

  if (measured) {
    throw new ExperimentError(
      `Content item ${input.contentItemId} has already been measured, so it ` +
        `cannot join an experiment. Its result is known, and enrolling it ` +
        `now would mean choosing a data point by its outcome. Assign items ` +
        `before they publish.`,
    );
  }

  const existing = db
    .select({ experimentId: contentExperiments.experimentId })
    .from(contentExperiments)
    .where(eq(contentExperiments.contentItemId, input.contentItemId))
    .all();

  if (existing.some((e) => e.experimentId === input.experimentId)) {
    throw new ExperimentError(
      `Content item ${input.contentItemId} is already in this experiment. ` +
        `Moving it between arms after the fact would mean choosing where to ` +
        `put a data point once its value is known.`,
    );
  }

  const otherIds = existing
    .map((e) => e.experimentId)
    .filter((eid) => eid !== input.experimentId);

  if (otherIds.length > 0) {
    const clashing = db
      .select({ id: experiments.id })
      .from(experiments)
      .where(
        and(
          inArray(experiments.id, otherIds),
          eq(experiments.status, 'RUNNING'),
        ),
      )
      .all();

    if (clashing.length > 0) {
      throw new ExperimentError(
        `Content item ${input.contentItemId} is already in running ` +
          `experiment ${clashing[0]!.id}. Two experiments over the same ` +
          `posts confound each other, and neither result would mean ` +
          `anything.`,
      );
    }
  }

  db.insert(contentExperiments)
    .values({
      contentItemId: input.contentItemId,
      experimentId: input.experimentId,
      // Stored as registered, not as typed, so the arms read consistently.
      variant: arm === 'control' ? pre.control.name : pre.treatment.name,
    })
    .run();
}

export function unassignVariant(
  db: DB,
  input: { experimentId: number; contentItemId: number },
): void {
  const record = row(db, input.experimentId);

  // Removing a measured item from a running arm is the same manoeuvre as
  // moving it: dropping a data point whose value you already know.
  if (record.status !== 'DRAFT' && record.status !== 'RUNNING') {
    throw new ExperimentError(
      `Experiment ${input.experimentId} is ${record.status} and its ` +
        `assignments are part of the record.`,
    );
  }

  const measured = db
    .select({ id: analyticsSnapshots.id })
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.contentItemId, input.contentItemId))
    .get();

  if (measured) {
    throw new ExperimentError(
      `Content item ${input.contentItemId} has already been measured. ` +
        `Removing it now would mean dropping a data point whose value is ` +
        `already known — abandon the experiment instead.`,
    );
  }

  db.delete(contentExperiments)
    .where(
      and(
        eq(contentExperiments.experimentId, input.experimentId),
        eq(contentExperiments.contentItemId, input.contentItemId),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Reading the arms
// ---------------------------------------------------------------------------

export interface ArmValues {
  readonly control: number[];
  readonly treatment: number[];
  /** Assigned but not yet measurable — awaiting publication or metrics. */
  readonly pending: number;
}

/**
 * The measured metric value for every assigned item, split by arm.
 *
 * Reads the same latest-snapshot-per-item shape the rest of the system uses,
 * and excludes an item whose metric cannot be computed rather than counting
 * it as zero (§40). An unmeasured post is pending, not a zero-performing one.
 */
export function armValues(db: DB, id: number): ArmValues {
  const record = row(db, id);
  const pre = preRegistrationOf(record);
  const metric = record.metric as MetricName;

  const assignments = db
    .select({
      contentItemId: contentExperiments.contentItemId,
      variant: contentExperiments.variant,
      state: contentItems.state,
    })
    .from(contentExperiments)
    .innerJoin(contentItems, eq(contentItems.id, contentExperiments.contentItemId))
    .where(eq(contentExperiments.experimentId, id))
    .all();

  const control: number[] = [];
  const treatment: number[] = [];
  let pending = 0;

  for (const assignment of assignments) {
    const arm = armFor(
      { control: pre.control, treatment: pre.treatment },
      assignment.variant,
    );
    if (!arm) {
      // Stored variants are normalised on write, so this is unreachable
      // unless the definition changed underneath. Counting it as pending is
      // the only safe reading: it is certainly not evidence.
      pending += 1;
      continue;
    }

    if (!MEASURABLE_STATES.includes(assignment.state as 'PUBLISHED')) {
      pending += 1;
      continue;
    }

    const snapshot = db
      .select({
        impressions: analyticsSnapshots.impressions,
        reach: analyticsSnapshots.reach,
        follows: analyticsSnapshots.follows,
        likes: analyticsSnapshots.likes,
        comments: analyticsSnapshots.comments,
        saves: analyticsSnapshots.saves,
        shares: analyticsSnapshots.shares,
      })
      .from(analyticsSnapshots)
      .where(eq(analyticsSnapshots.contentItemId, assignment.contentItemId))
      .orderBy(desc(analyticsSnapshots.capturedAt))
      .get();

    if (!snapshot) {
      pending += 1;
      continue;
    }

    const value =
      metric === 'follows/1k'
        ? followsPerThousandImpressions(
            snapshot.follows,
            snapshot.impressions ?? snapshot.reach,
          )
        : engagementRate({
            likes: snapshot.likes,
            comments: snapshot.comments,
            saves: snapshot.saves,
            shares: snapshot.shares,
            reach: snapshot.reach,
            impressions: snapshot.impressions,
          });

    // Absent, not zero (§40). A post whose metric the platform did not report
    // is pending, not a post that performed at zero.
    if (value === null) {
      pending += 1;
      continue;
    }

    if (arm === 'control') control.push(value);
    else treatment.push(value);
  }

  return { control, treatment, pending };
}

/** Why this experiment cannot be concluded yet, or null when it can. */
export function conclusionBlocker(db: DB, id: number): string | null {
  const record = row(db, id);

  if (record.status !== 'RUNNING') {
    return `An experiment that is ${record.status} cannot be concluded.`;
  }

  const pre = preRegistrationOf(record);
  const values = armValues(db, id);
  return blocksConclusion(pre, values.control, values.treatment);
}

// ---------------------------------------------------------------------------
// Concluding
// ---------------------------------------------------------------------------

export interface ConcludeReport {
  readonly conclusion: Conclusion;
  /** The finding id, when the verdict earned one. */
  readonly findingId: number | null;
}

/**
 * Concludes an experiment on its pre-registered terms.
 *
 * All of it in one transaction: an experiment marked CONCLUDED without its
 * finding written, or a SUPPORTED finding with no concluded experiment behind
 * it, would each be a claim without its evidence.
 *
 * A REFUTED or INCONCLUSIVE verdict is recorded on the experiment and earns
 * no finding. That is not the result being discarded — it is the result being
 * kept where the terms that produced it are visible, rather than promoted
 * into something the system believes.
 */
export function concludeExperiment(
  db: DB,
  id: number,
  opts: { now?: Date } = {},
): ConcludeReport {
  const now = opts.now ?? new Date();
  const record = row(db, id);

  if (!canTransition(record.status, 'CONCLUDED')) {
    throw new ExperimentError(
      `An experiment that is ${record.status} cannot be concluded.`,
    );
  }

  const pre = preRegistrationOf(record);
  const values = armValues(db, id);

  // Throws when either arm is short of the registered minimum. Refusing is
  // the point: concluding early is optional stopping, which manufactures
  // significance out of noise.
  const conclusion = concludeInDomain(pre, values.control, values.treatment);
  const finding = findingFor(pre, conclusion);

  let findingId: number | null = null;

  db.transaction((tx) => {
    tx.update(experiments)
      .set({
        status: 'CONCLUDED',
        verdict: conclusion.verdict,
        result: conclusion.summary,
        confidence: conclusion.confidence,
        endAt: now.getTime(),
        updatedAt: now.getTime(),
      })
      .where(eq(experiments.id, id))
      .run();

    if (finding) {
      findingId = tx
        .insert(learningFindings)
        .values({
          dimension: finding.dimension,
          segment: finding.segment,
          metric: finding.metric,
          effectSize: finding.effectSize,
          sampleSize: finding.sampleSize,
          confidence: finding.confidence,
          status: finding.status,
          summary: finding.summary,
          experimentId: id,
          computedAt: now.getTime(),
          createdAt: now.getTime(),
          updatedAt: now.getTime(),
        })
        .returning({ id: learningFindings.id })
        .get().id;
    }
  });

  db.insert(systemEvents)
    .values({
      kind: 'experiment.concluded',
      severity: 'INFO',
      payload: JSON.stringify({
        experimentId: id,
        verdict: conclusion.verdict,
        metric: pre.metric,
        control: conclusion.control.sampleSize,
        treatment: conclusion.treatment.sampleSize,
      }),
    })
    .run();

  return { conclusion, findingId };
}

// ---------------------------------------------------------------------------
// Reads for the UI
// ---------------------------------------------------------------------------

export interface ExperimentSummary {
  readonly id: number;
  readonly hypothesis: string;
  readonly metric: string;
  readonly status: string;
  readonly verdict: string | null;
  readonly minSampleSize: number;
  readonly controlName: string;
  readonly treatmentName: string;
  readonly controlCount: number;
  readonly treatmentCount: number;
  readonly pending: number;
  readonly startAt: number | null;
  readonly endAt: number | null;
  readonly result: string | null;
  readonly confidence: string | null;
  /** Null when the terms are unreadable — shown rather than hidden. */
  readonly blocker: string | null;
}

function toSummary(db: DB, record: typeof experiments.$inferSelect): ExperimentSummary {
  const base = {
    id: record.id,
    hypothesis: record.hypothesis,
    metric: record.metric,
    status: record.status,
    verdict: record.verdict ?? null,
    minSampleSize: record.minSampleSize,
    startAt: record.startAt,
    endAt: record.endAt,
    result: record.result,
    confidence: record.confidence,
  };

  try {
    const pre = preRegistrationOf(record);
    const values = armValues(db, record.id);
    return {
      ...base,
      controlName: pre.control.name,
      treatmentName: pre.treatment.name,
      controlCount: values.control.length,
      treatmentCount: values.treatment.length,
      pending: values.pending,
      blocker:
        record.status === 'RUNNING'
          ? blocksConclusion(pre, values.control, values.treatment)
          : null,
    };
  } catch (error) {
    // A broken definition is surfaced, not swallowed. An experiment whose
    // terms cannot be read must be visibly unusable rather than absent.
    return {
      ...base,
      controlName: '(unreadable)',
      treatmentName: '(unreadable)',
      controlCount: 0,
      treatmentCount: 0,
      pending: 0,
      blocker:
        error instanceof Error
          ? `This experiment\u2019s terms cannot be read: ${error.message}`
          : 'This experiment\u2019s terms cannot be read.',
    };
  }
}

export function listExperiments(db: DB): ExperimentSummary[] {
  return db
    .select()
    .from(experiments)
    .orderBy(desc(experiments.createdAt))
    .all()
    .map((record) => toSummary(db, record));
}

export interface AssignedItem {
  readonly contentItemId: number;
  readonly variant: string;
  readonly platform: string;
  readonly format: string;
  readonly state: string;
  readonly topic: string | null;
  /** Null when not yet measured — never 0 (§40). */
  readonly value: number | null;
}

export function assignmentsFor(db: DB, id: number): AssignedItem[] {
  const record = row(db, id);
  const metric = record.metric as MetricName;

  return db
    .select({
      contentItemId: contentExperiments.contentItemId,
      variant: contentExperiments.variant,
      platform: contentItems.platform,
      format: contentItems.format,
      state: contentItems.state,
      topic: contentItems.topic,
    })
    .from(contentExperiments)
    .innerJoin(contentItems, eq(contentItems.id, contentExperiments.contentItemId))
    .where(eq(contentExperiments.experimentId, id))
    .all()
    .map((assignment) => {
      const snapshot = db
        .select({
          impressions: analyticsSnapshots.impressions,
          reach: analyticsSnapshots.reach,
          follows: analyticsSnapshots.follows,
          likes: analyticsSnapshots.likes,
          comments: analyticsSnapshots.comments,
          saves: analyticsSnapshots.saves,
          shares: analyticsSnapshots.shares,
        })
        .from(analyticsSnapshots)
        .where(eq(analyticsSnapshots.contentItemId, assignment.contentItemId))
        .orderBy(desc(analyticsSnapshots.capturedAt))
        .get();

      const value = !snapshot
        ? null
        : metric === 'follows/1k'
          ? followsPerThousandImpressions(
              snapshot.follows,
              snapshot.impressions ?? snapshot.reach,
            )
          : engagementRate({
              likes: snapshot.likes,
              comments: snapshot.comments,
              saves: snapshot.saves,
              shares: snapshot.shares,
              reach: snapshot.reach,
              impressions: snapshot.impressions,
            });

      return { ...assignment, value };
    });
}

export function experimentDetail(db: DB, id: number) {
  const record = row(db, id);

  let arms: { control: Arm; treatment: Arm } | null;
  try {
    const pre = preRegistrationOf(record);
    arms = { control: pre.control, treatment: pre.treatment };
  } catch {
    arms = null;
  }

  return {
    ...toSummary(db, record),
    arms,
    assignments: assignmentsFor(db, id),
  };
}

/**
 * Items that could join a running experiment.
 *
 * Excludes anything already in a running experiment, and anything already
 * measured — an item whose result is known cannot be enrolled without
 * choosing a data point by its outcome.
 *
 * Unpublished items are included on purpose: assigning before publishing is
 * the correct order, and the only one that yields data the experiment did not
 * select.
 */
export function assignableItems(db: DB, experimentId: number, limit = 50) {
  const takenIds = db
    .select({ contentItemId: contentExperiments.contentItemId })
    .from(contentExperiments)
    .innerJoin(experiments, eq(experiments.id, contentExperiments.experimentId))
    .where(
      and(
        eq(experiments.status, 'RUNNING'),
        ne(contentExperiments.experimentId, experimentId),
      ),
    )
    .all()
    .map((r) => r.contentItemId);

  const alreadyHere = db
    .select({ contentItemId: contentExperiments.contentItemId })
    .from(contentExperiments)
    .where(eq(contentExperiments.experimentId, experimentId))
    .all()
    .map((r) => r.contentItemId);

  const measuredIds = db
    .selectDistinct({ contentItemId: analyticsSnapshots.contentItemId })
    .from(analyticsSnapshots)
    .all()
    .map((r) => r.contentItemId);

  const excluded = [
    ...new Set([...takenIds, ...alreadyHere, ...measuredIds]),
  ];

  const rows = db
    .select({
      id: contentItems.id,
      platform: contentItems.platform,
      format: contentItems.format,
      state: contentItems.state,
      topic: contentItems.topic,
    })
    .from(contentItems)
    .orderBy(desc(contentItems.createdAt))
    .all();

  return rows.filter((r) => !excluded.includes(r.id)).slice(0, limit);
}

/** Findings earned by experiments — the only SUPPORTED ones (§30). */
export function experimentFindings(db: DB) {
  return db
    .select()
    .from(learningFindings)
    .where(isNotNull(learningFindings.experimentId))
    .orderBy(desc(learningFindings.computedAt))
    .all();
}

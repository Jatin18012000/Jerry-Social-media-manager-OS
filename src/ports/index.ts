/**
 * Ports — PRD §35 (model abstraction) and §65 (no vendor lock-in).
 *
 * These are interfaces only. Every external dependency the system has enters
 * through one of them, and the domain and application layers depend on these
 * types rather than on any concrete provider.
 *
 * The property that matters: each port has a manual or local implementation
 * for V1 and an API implementation later, and swapping between them is
 * configuration (see src/config/env.ts), not a code change. That is §64's
 * FOUNDATION -> PRODUCTION migration path.
 */

import type {
  CharacterMode,
  ContentFormat,
  Language,
  Platform,
} from '@/domain/content';
import type { ClaimType, EvidenceTier } from '@/domain/evidence';

// ---------------------------------------------------------------------------
// AIProvider — §35, §36
// ---------------------------------------------------------------------------

export interface GenerationRequest {
  readonly brief: string;
  readonly platform: Platform;
  readonly format: ContentFormat;
  readonly language: Language;
  readonly characterMode: CharacterMode;
}

export interface GenerationResult {
  /** Always the provider's unmodified output. Persisted before parsing. */
  readonly rawResponse: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Implementations:
 *   ManualProvider     V1 — renders the brief for copy-paste, accepts the
 *                      pasted response. Decision D3.
 *   OllamaProvider     local, free — mechanical work only.
 *   AnthropicProvider  when a budget is authorised.
 *   GeminiProvider     when a budget is authorised.
 */
export interface AIProvider {
  readonly name: string;
  /** False for ManualProvider: a human supplies the response out of band. */
  readonly isAutomated: boolean;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

// ---------------------------------------------------------------------------
// Publisher — §25, §39, §40
// ---------------------------------------------------------------------------

export interface PublishRequest {
  readonly contentItemId: number;
  readonly platform: Platform;
  readonly format: ContentFormat;
  readonly caption: string;
  readonly mediaPaths: readonly string[];
  /** hash(contentItemId, platform, runAt). §39. */
  readonly idempotencyKey: string;
}

export type PublishResult =
  | {
      readonly outcome: 'PUBLISHED';
      /** Platform's own ID. Null only for a human-confirmed manual publish. */
      readonly externalId: string | null;
      readonly externalUrl: string | null;
      readonly confirmedBy: string | null;
      readonly publishedAt: Date;
    }
  | {
      /** ManualPublisher: prepared and handed to a human, not yet live. */
      readonly outcome: 'AWAITING_HUMAN';
      readonly instructions: string;
    }
  | {
      readonly outcome: 'FAILED';
      readonly error: string;
      readonly retryable: boolean;
    };

/**
 * §40: "Platform API fails -> do not mark content as published."
 *
 * A Publisher never reports PUBLISHED without evidence. The domain enforces
 * the same rule again on the state transition, and the database enforces it a
 * third time with a CHECK constraint. Three layers, because a double publish
 * or a falsely-published item is not recoverable.
 */
export interface Publisher {
  readonly name: string;
  readonly kind: 'MANUAL' | 'INSTAGRAM_API' | 'LINKEDIN_API';
  supports(platform: Platform): boolean;
  publish(request: PublishRequest): Promise<PublishResult>;
}

// ---------------------------------------------------------------------------
// AnalyticsSource — §26, §40, decision D4
// ---------------------------------------------------------------------------

/**
 * Every field is optional. §26 says metric availability depends on the
 * platform, and §40 forbids fabricating metrics — so a metric that was not
 * reported is absent, never zero.
 */
export interface MetricReading {
  readonly impressions?: number;
  readonly reach?: number;
  readonly views?: number;
  readonly likes?: number;
  readonly comments?: number;
  readonly saves?: number;
  readonly shares?: number;
  readonly profileVisits?: number;
  readonly follows?: number;
  readonly watchTimeSeconds?: number;
  readonly retentionPct?: number;
  readonly clicks?: number;
}

export interface AnalyticsReading {
  readonly metrics: MetricReading;
  readonly capturedAt: Date;
  readonly source: 'OCR' | 'MANUAL' | 'API';
  /** 0..1. Below threshold, the reading needs human confirmation (D4). */
  readonly confidence: number;
  readonly rawText?: string;
}

export interface AnalyticsSource {
  readonly name: string;
  /** True when a human must confirm before the reading is persisted. */
  readonly requiresConfirmation: boolean;
  read(input: { contentItemId: number; payload: unknown }): Promise<AnalyticsReading>;
}

// ---------------------------------------------------------------------------
// SourceFetcher — §14, decision D5
// ---------------------------------------------------------------------------

export interface FetchedItem {
  readonly title: string;
  readonly url: string;
  readonly summary?: string;
  readonly publishedAt?: Date;
  readonly rawContent?: string;
}

export interface ExtractedClaim {
  readonly text: string;
  readonly claimType: ClaimType;
  readonly evidenceUrl?: string;
  readonly evidenceTier?: EvidenceTier;
}

/**
 * Implementations: RssFetcher, ArxivFetcher, HackerNewsFetcher,
 * ManualUrlFetcher. All free and official — §25 rules out scraping as an
 * architectural foundation.
 */
export interface SourceFetcher {
  readonly name: string;
  readonly kind: 'RSS' | 'ATOM' | 'ARXIV' | 'HACKER_NEWS' | 'MANUAL';
  fetch(input: { url: string; since?: Date }): Promise<readonly FetchedItem[]>;
}

// ---------------------------------------------------------------------------
// Notifier — §47
// ---------------------------------------------------------------------------

export type NotificationKind =
  | 'CONTENT_READY_FOR_REVIEW'
  | 'SCHEDULED'
  | 'PUBLISH_FAILED'
  | 'JOB_MISSED'
  | 'IMPORTANT_RESEARCH'
  | 'UNUSUAL_PERFORMANCE'
  | 'SYSTEM_FAILURE';

export interface Notification {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly contentItemId?: number;
}

/**
 * §48: email is a notification channel, never the database or the
 * orchestration mechanism.
 */
export interface Notifier {
  readonly name: string;
  notify(notification: Notification): Promise<void>;
}

// ---------------------------------------------------------------------------
// StructuredProvider — §35, §36, and the automation guide's §7
// ---------------------------------------------------------------------------

/**
 * A request for structured output from a model.
 *
 * Separate from `AIProvider` because the two do different jobs. `AIProvider`
 * produces prose for a human to review; this produces a typed judgement the
 * application acts on — a classification, a score, a tag. Under decision D3
 * generation stays human; only this side is automated.
 */
export interface StructuredTask<T> {
  /** Names the job, for logging and cost attribution (§43, §44). */
  readonly task: string;
  readonly instruction: string;
  readonly input: unknown;
  /** The caller validates the output; the model is never trusted to. */
  readonly parse: (raw: unknown) => T | null;
  readonly temperature?: number;
}

/**
 * Normalised result plus metadata.
 *
 * `output` is null on any failure — unreachable model, malformed JSON, output
 * that did not satisfy the schema. The caller then falls back. A provider must
 * never return a partially-valid object as if it were valid, because a
 * half-parsed classification is worse than none: it looks usable.
 */
export interface StructuredRun<T> {
  readonly output: T | null;
  readonly provider: string;
  readonly model: string | null;
  readonly durationMs: number;
  readonly status: 'OK' | 'UNAVAILABLE' | 'INVALID_OUTPUT' | 'ERROR';
  readonly error?: string;
}

/**
 * Implementations: OllamaProvider (local Qwen, free). Anthropic or Gemini
 * could implement the same port if a budget is ever authorised.
 *
 * `available()` exists because the local model is genuinely optional — the
 * laptop may not be running Ollama, and the system must degrade to its
 * deterministic heuristics rather than fail.
 */
export interface StructuredProvider {
  readonly name: string;
  readonly model: string | null;
  available(): Promise<boolean>;
  run<T>(task: StructuredTask<T>): Promise<StructuredRun<T>>;
}

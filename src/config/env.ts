/**
 * Environment configuration — PRD §64 (one codebase, mode-switched) and §41
 * (no secrets in source).
 *
 * Every adapter choice in the system is made here, from environment, so that
 * moving from FOUNDATION to PRODUCTION is configuration rather than a code
 * change. Nothing in this file may contain a credential.
 */

import { z } from 'zod';

const schema = z.object({
  /** §64. FOUNDATION = local and free. PRODUCTION = cloud and paid. */
  MODE: z.enum(['FOUNDATION', 'PRODUCTION']).default('FOUNDATION'),

  DATABASE_URL: z.string().min(1).default('./data/os.db'),

  /**
   * Required whenever the app is actually served, because it binds to
   * 0.0.0.0 for LAN access from iPad and iPhone (§46). Optional in tests.
   */
  SESSION_SECRET: z.string().min(32).optional(),

  /** The single user's passphrase. Required alongside SESSION_SECRET (§41). */
  APP_PASSPHRASE: z.string().min(1).optional(),

  /** §36 model routing. V1 is MANUAL under decision D3. */
  AI_GENERATION_MODE: z.enum(['MANUAL', 'ANTHROPIC', 'GEMINI']).default('MANUAL'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  /** Local model for mechanical work: dedupe, classification, scoring. */
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().optional(),

  /** §25. V1 is MANUAL until platform API access clears. */
  PUBLISHER_MODE: z.enum(['MANUAL', 'LIVE']).default('MANUAL'),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),

  /** D4. OCR with a manual fallback. */
  ANALYTICS_MODE: z.enum(['OCR', 'MANUAL', 'API']).default('OCR'),
});

export type Env = z.infer<typeof schema>;

/**
 * Parses and validates the environment.
 *
 * Fails loudly on a bad configuration rather than starting in a half-working
 * state — a silently disabled publisher is worse than a refused boot.
 */
export function loadEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // §32 / §36: an API generation mode without a key would fail at the worst
  // possible moment — mid-generation — so refuse it at boot instead.
  if (env.AI_GENERATION_MODE === 'ANTHROPIC' && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      'AI_GENERATION_MODE=ANTHROPIC requires ANTHROPIC_API_KEY. ' +
        'V1 runs with AI_GENERATION_MODE=MANUAL (decision D3).',
    );
  }
  if (env.AI_GENERATION_MODE === 'GEMINI' && !env.GEMINI_API_KEY) {
    throw new Error(
      'AI_GENERATION_MODE=GEMINI requires GEMINI_API_KEY. ' +
        'V1 runs with AI_GENERATION_MODE=MANUAL (decision D3).',
    );
  }

  return env;
}

/** True when running the free, local, MacBook-only configuration (§32, §34). */
export function isFoundationMode(env: Env): boolean {
  return env.MODE === 'FOUNDATION';
}

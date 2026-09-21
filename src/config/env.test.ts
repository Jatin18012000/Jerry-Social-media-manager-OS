import { describe, expect, it } from 'vitest';

import { isFoundationMode, loadEnv } from './env';

const base = { SESSION_SECRET: 'x'.repeat(32) };

describe('environment configuration', () => {
  it('defaults to the free, local, manual V1 configuration', () => {
    const env = loadEnv({ ...base });
    expect(env.MODE).toBe('FOUNDATION');
    expect(env.AI_GENERATION_MODE).toBe('MANUAL');
    expect(env.PUBLISHER_MODE).toBe('MANUAL');
    expect(env.ANALYTICS_MODE).toBe('OCR');
    expect(isFoundationMode(env)).toBe(true);
  });

  it('refuses an API generation mode with no key, at boot', () => {
    expect(() =>
      loadEnv({
        ...base,
        AI_GENERATION_MODE: 'ANTHROPIC',
      }),
    ).toThrow(/requires ANTHROPIC_API_KEY/);

    expect(() =>
      loadEnv({ ...base, AI_GENERATION_MODE: 'GEMINI' }),
    ).toThrow(/requires GEMINI_API_KEY/);
  });

  it('accepts an API generation mode once a key is present', () => {
    const env = loadEnv({
      ...base,
      AI_GENERATION_MODE: 'ANTHROPIC',
      ANTHROPIC_API_KEY: 'test-key',
    });
    expect(env.AI_GENERATION_MODE).toBe('ANTHROPIC');
  });

  it('rejects an unknown mode rather than falling back silently', () => {
    expect(() =>
      loadEnv({ ...base, MODE: 'STAGING' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('rejects a session secret that is too short to be useful', () => {
    expect(() =>
      loadEnv({ SESSION_SECRET: 'short' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('switches to production mode when asked', () => {
    const env = loadEnv({ ...base, MODE: 'PRODUCTION' });
    expect(isFoundationMode(env)).toBe(false);
  });
});

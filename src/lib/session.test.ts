import { describe, expect, it } from 'vitest';

import {
  SESSION_TTL_MS,
  createSessionToken,
  timingSafeEqual,
  verifySessionToken,
} from './session';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const NOW = Date.parse('2026-09-21T12:00:00Z');

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('correct horse', 'correct horse')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(timingSafeEqual('correct horse', 'correct horsf')).toBe(false);
  });

  it('rejects strings of different lengths', () => {
    expect(timingSafeEqual('short', 'shorter')).toBe(false);
  });

  it('rejects a prefix of the real value', () => {
    // The naive `===` short-circuits here, which is what leaks the prefix.
    expect(timingSafeEqual('corr', 'correct horse')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });

  it('handles multi-byte characters', () => {
    expect(timingSafeEqual('पासवर्ड', 'पासवर्ड')).toBe(true);
    expect(timingSafeEqual('पासवर्ड', 'पासवर्ङ')).toBe(false);
  });
});

describe('session tokens', () => {
  it('issues a token that verifies', async () => {
    const token = await createSessionToken(SECRET, { now: NOW });
    expect(await verifySessionToken(token, SECRET, { now: NOW })).toBe(true);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await createSessionToken(OTHER_SECRET, { now: NOW });
    expect(await verifySessionToken(token, SECRET, { now: NOW })).toBe(false);
  });

  it('rejects a token past its expiry', async () => {
    const token = await createSessionToken(SECRET, { now: NOW, ttlMs: 1000 });
    expect(
      await verifySessionToken(token, SECRET, { now: NOW + 2000 }),
    ).toBe(false);
  });

  it('accepts a token inside its expiry', async () => {
    const token = await createSessionToken(SECRET, { now: NOW });
    expect(
      await verifySessionToken(token, SECRET, {
        now: NOW + SESSION_TTL_MS - 1000,
      }),
    ).toBe(true);
  });
});

describe('session tokens — tampering', () => {
  it('rejects a payload rewritten to extend the expiry', async () => {
    // The whole point of signing: an attacker must not be able to grant
    // themselves a longer session by editing the cookie.
    const token = await createSessionToken(SECRET, { now: NOW, ttlMs: 1000 });
    const signature = token.slice(token.lastIndexOf('.') + 1);
    const forged = `${NOW + 10 ** 12}.${signature}`;

    expect(await verifySessionToken(forged, SECRET, { now: NOW })).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const token = await createSessionToken(SECRET, { now: NOW });
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifySessionToken(tampered, SECRET, { now: NOW })).toBe(false);
  });

  it('rejects an unsigned payload', async () => {
    expect(
      await verifySessionToken(String(NOW + 10 ** 9), SECRET, { now: NOW }),
    ).toBe(false);
  });

  it('rejects a non-numeric payload', async () => {
    expect(
      await verifySessionToken('forever.abc', SECRET, { now: NOW }),
    ).toBe(false);
  });

  it('rejects malformed base64 in the signature without throwing', async () => {
    await expect(
      verifySessionToken(`${NOW + 1000}.!!!not base64!!!`, SECRET, { now: NOW }),
    ).resolves.toBe(false);
  });

  it('rejects an absent or empty token', async () => {
    expect(await verifySessionToken(undefined, SECRET)).toBe(false);
    expect(await verifySessionToken(null, SECRET)).toBe(false);
    expect(await verifySessionToken('', SECRET)).toBe(false);
  });

  it('rejects a token with no separator', async () => {
    expect(await verifySessionToken('garbage', SECRET)).toBe(false);
  });

  it('rejects a token that is only a separator', async () => {
    expect(await verifySessionToken('.', SECRET)).toBe(false);
  });
});

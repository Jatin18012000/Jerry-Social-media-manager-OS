/**
 * Session tokens — PRD §41.
 *
 * The app binds to 0.0.0.0 so the dashboard is reachable from an iPad or
 * iPhone on the home network (§46). That makes it reachable from every other
 * device on that network too — including anything else connected to the
 * router. An unauthenticated approval queue on a shared network is not
 * acceptable, and §22's human gate means nothing if someone else can click it.
 *
 * Built on Web Crypto rather than node:crypto so the same code runs in
 * middleware (edge runtime) and in a server action (node runtime). A second
 * implementation for the second runtime would be a second thing to get wrong.
 *
 * The token is a signed expiry, nothing more. There is one user, so there is
 * no identity to carry and nothing worth putting in a payload.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'smos_session';

/** Long enough not to be re-entered daily, short enough to expire. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i);
  return buffer;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Compares two strings without leaking their difference through timing.
 *
 * A naive `===` returns as soon as it finds a mismatched character, which
 * tells an attacker how much of a guess was correct.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Always compare the same number of bytes, so length does not leak either.
  const length = Math.max(aBytes.length, bBytes.length);
  let mismatch = aBytes.length ^ bBytes.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return mismatch === 0;
}

/** Issues a token valid until `now + ttl`. */
export async function createSessionToken(
  secret: string,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<string> {
  const expiresAt = (opts.now ?? Date.now()) + (opts.ttlMs ?? SESSION_TTL_MS);
  const payload = String(expiresAt);

  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(payload),
  );

  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a token.
 *
 * Returns false for anything malformed, wrongly signed or expired. The
 * signature is checked *before* the expiry is trusted — an unsigned payload
 * could otherwise claim any expiry it liked.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  opts: { now?: number } = {},
): Promise<boolean> {
  if (!token) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  if (!/^\d+$/.test(payload)) return false;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlDecode(signature),
      encoder.encode(payload),
    );
  } catch {
    // Malformed base64, wrong length — all the same answer.
    return false;
  }

  if (!valid) return false;

  return Number(payload) > (opts.now ?? Date.now());
}

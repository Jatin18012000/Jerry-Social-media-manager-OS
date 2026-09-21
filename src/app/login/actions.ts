'use server';

import { cookies } from 'next/headers';

import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
  timingSafeEqual,
} from '@/lib/session';

export interface LoginResult {
  readonly ok: boolean;
  readonly message: string;
  readonly next?: string;
}

/**
 * Signs in — PRD §41.
 *
 * One user, one passphrase, held in the environment. The comparison is
 * timing-safe, and a wrong passphrase and a missing one give the same answer:
 * telling an attacker which of the two it was helps only them.
 */
export async function signIn(
  _prev: LoginResult | null,
  formData: FormData,
): Promise<LoginResult> {
  const secret = process.env.SESSION_SECRET;
  const expected = process.env.APP_PASSPHRASE;
  const supplied = String(formData.get('passphrase') ?? '');
  const next = String(formData.get('next') ?? '/');

  if (!secret || secret.length < 32 || !expected) {
    return {
      ok: false,
      message:
        'Not configured. Set SESSION_SECRET (32+ chars) and APP_PASSPHRASE ' +
        'in .env.local, then restart.',
    };
  }

  if (!timingSafeEqual(supplied, expected)) {
    return { ok: false, message: 'That passphrase is not right.' };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    // The app is served over plain HTTP on a home LAN, so Secure would stop
    // the cookie being set at all. It never leaves the local network.
    secure: false,
  });

  return { ok: true, message: 'Signed in.', next: next.startsWith('/') ? next : '/' };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { type LoginResult, signIn } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginResult | null, FormData>(
    signIn,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      router.replace(state.next ?? '/');
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="next" value={next} />
      <input
        type="password"
        name="passphrase"
        placeholder="Passphrase"
        aria-label="Passphrase"
        autoFocus
        required
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Sign in'}
      </button>
      {state && !state.ok && <p className="error small">{state.message}</p>}
    </form>
  );
}

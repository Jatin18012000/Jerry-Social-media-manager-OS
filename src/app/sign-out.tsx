'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { signOut } from './login/actions';

export function SignOutLink() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="button"
      className="link-button nav-signout"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOut();
          router.replace('/login');
          router.refresh();
        })
      }
    >
      {pending ? '…' : 'Sign out'}
    </button>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { SignOutLink } from './sign-out';

export const metadata: Metadata = {
  title: 'Social Media OS',
  description: 'Research, create, verify, approve, schedule, measure, learn.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="top">
          <a href="/">Overview</a>
          <a href="/research">Research</a>
          <a href="/opportunities">Opportunities</a>
          <a href="/review">Review</a>
          <a href="/schedule">Schedule</a>
          <a href="/analytics">Analytics</a>
          <SignOutLink />
        </nav>
        {children}
      </body>
    </html>
  );
}

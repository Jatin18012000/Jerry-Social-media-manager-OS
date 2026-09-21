import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

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
        </nav>
        {children}
      </body>
    </html>
  );
}

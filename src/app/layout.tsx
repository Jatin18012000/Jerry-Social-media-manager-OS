import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Nav } from './nav';

export const metadata: Metadata = {
  title: 'Social Media OS',
  description: 'Research, create, verify, approve, schedule, measure, learn.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}

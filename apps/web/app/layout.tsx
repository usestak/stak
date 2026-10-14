import type { ReactNode } from 'react';

import { SkipLink } from './_components/skip-link';
import './globals.css';

export const metadata = {
  title: {
    // `default` keeps the existing "STAK Cloud" service term as-is — P11 only
    // changes the public PRODUCT brand (Memory STAK), and "STAK Cloud" is used
    // consistently as an internal service name throughout the app's own copy
    // (error/empty states); changing just this one occurrence would diverge
    // from that pattern rather than fix it (see P11 report, "STAK Cloud" item).
    default: 'STAK Cloud',
    template: 'Memory STAK — %s',
  },
  description: 'Portable AI agent environments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}

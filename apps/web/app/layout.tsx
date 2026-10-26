import type { ReactNode } from 'react';

import { SkipLink } from './_components/skip-link';
import { StakSyncMount } from './_components/stak-sync-mount';
import './globals.css';

export const metadata = {
  metadataBase: new URL('https://www.memstk.com'),
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
  applicationName: 'Memory STAK',
  openGraph: {
    siteName: 'Memory STAK',
    type: 'website',
    url: 'https://www.memstk.com',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SkipLink />
        <StakSyncMount />
        {children}
      </body>
    </html>
  );
}

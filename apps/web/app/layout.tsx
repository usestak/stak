import type { ReactNode } from 'react';

import { SkipLink } from './_components/skip-link';
import './globals.css';

export const metadata = {
  title: 'STAK Cloud',
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

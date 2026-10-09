import type { ReactNode } from 'react';

import { SkipLink } from './_components/skip-link';
import './globals.css';

export const metadata = {
  title: {
    default: 'STAK Cloud',
    template: 'STAK — %s',
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

import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'Stack Cloud',
  description: 'Portable AI agent environments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

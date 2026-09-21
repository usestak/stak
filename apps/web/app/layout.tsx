import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'Stack Cloud',
  description: 'Portable AI agent environments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <a href="/" className="wordmark">
              Stack
            </a>
          </div>
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}

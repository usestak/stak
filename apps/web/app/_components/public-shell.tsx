import type { ReactNode } from 'react';
import Link from 'next/link';

import '../overview/shell.css';
import './public-shell.css';

/**
 * Shared chrome for the anonymous-facing public Stack/share pages (/[owner],
 * /[owner]/[slug]). Same STAK Final Contract tokens/typography as the signed-in
 * shell (overview/shell.css) and the focused-flow shell, but with no sidebar and
 * no account menu — these are reference-only surfaces for signed-out visitors,
 * never a signed-in dashboard. Replaces the retired SiteHeader + globals.css
 * .page/.card system.
 */
export function PublicShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      />
      <div className="stak stak-public">
        <nav className="stak-public-nav" aria-label="STAK">
          <Link href="/" className="stak-public-wordmark">
            STAK
          </Link>
        </nav>
        <main className="stak-public-main">
          <h1>{title}</h1>
          {children}
        </main>
        <footer className="stak-public-footer">
          Reference only. Source availability is not verified by STAK.
        </footer>
      </div>
    </>
  );
}

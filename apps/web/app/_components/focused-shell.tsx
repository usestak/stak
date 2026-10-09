import type { ReactNode } from 'react';

import '../overview/shell.css';
import './focused-shell.css';

/**
 * The shared focused-flow shell (STAK Final Contract): no sidebar, a single narrow
 * card on the dark instrument-panel background — for auth/setup/session-completion
 * surfaces (sign-in, auth/error, CLI approval, onboarding, memory/protect, memory/recover).
 * Same tokens/typography/border/button language as the signed-in control center
 * (app-sidebar.tsx + overview/shell.css), just without the sidebar. Not a generic SaaS
 * auth card, and not globals.css, which stays reserved for the public Stack/share pages.
 */
export function FocusedShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
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
      <div className="stak stak-focus-page">
        <main id="main-content" className="stak-notice">
          <div className="stak-focus-brand">
            <b>STAK</b>
          </div>
          {eyebrow ? <div className="stak-focus-eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
          {children}
        </main>
      </div>
    </>
  );
}

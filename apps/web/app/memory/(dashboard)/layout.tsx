import type { ReactNode } from 'react';

import '../../overview/shell.css';

/**
 * Next.js scopes layouts per route segment, so `/memory` — a plain page sibling to the
 * CLI-driven `/memory/protect` and `/memory/recover` WebAuthn flows, which keep their own
 * `SiteHeader`/`globals.css` shell — needs the `.stak` wrapper WITHOUT also wrapping those
 * siblings. Putting this page inside a `(dashboard)` route group (invisible in the URL: this
 * still serves `/memory`) gives it its own layout slot that `protect/` and `recover/`, which
 * live outside the group, never inherit. Mirrors `apps/web/app/skills/layout.tsx`'s reason for
 * existing, adapted for the extra nested-route conflict `/memory` has and `/skills` doesn't.
 */
export default function MemoryDashboardLayout({
  children,
}: {
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
      <div className="stak">{children}</div>
    </>
  );
}

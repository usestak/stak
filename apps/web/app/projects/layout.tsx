import type { ReactNode } from 'react';
import type { Metadata } from 'next';

import '../overview/shell.css';

// Covers both /projects and /projects/[projectId] — signed-in, account-specific
// views of this user's own Projects. Never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/** No nested routes exist under `/projects` (unlike `/memory`), so this is a plain layout —
 *  same shape as `apps/web/app/skills/layout.tsx`. Copies its exact font-link markup, for the
 *  same reason: Next.js layouts are scoped to their own route segment, so `/projects` (a sibling
 *  of `/overview`, not nested under it) never inherits `.stak`'s CSS custom properties otherwise. */
export default function ProjectsLayout({ children }: { children: ReactNode }) {
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

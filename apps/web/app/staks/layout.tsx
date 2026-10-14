import type { ReactNode } from 'react';

import '../overview/shell.css';

/** `/staks` (and its nested `/staks/new`, `/staks/[stakId]` named-STAK routes) is a
 *  sibling of `/overview`, same shape as `apps/web/app/machines/layout.tsx` — it needs its
 *  own copy of the font-link markup to pick up `.stak`'s CSS custom properties. */
export default function StaksLayout({ children }: { children: ReactNode }) {
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

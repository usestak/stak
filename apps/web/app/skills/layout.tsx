import type { ReactNode } from 'react';
import type { Metadata } from 'next';

import '../overview/shell.css';

// Covers both /skills and /skills/[skillId] — signed-in, account-specific
// views of this user's own Skills. Never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Signed-in shell layout for the Skills route segment — the same `.stak` design-token wrapper
 * `overview/layout.tsx` provides. Next.js layouts are scoped to their own route segment, so
 * Skills (a sibling of `/overview`, not nested under it) never inherited `.stak`'s CSS custom
 * properties (--chip, --orange, --mono, --sans, …) until this file existed: every `.stak-*`
 * class here was silently falling back to globals.css's unrelated dark-mode `:root` tokens
 * (coincidentally similar enough in a couple of names — --bg — to look right at a glance) or to
 * nothing at all (found via the Pause button's missing border during P5 visual-correction
 * browser dogfood; same root cause as Overview's own layout, kept consistent on purpose).
 */
export default function SkillsLayout({ children }: { children: ReactNode }) {
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

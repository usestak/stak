import type { ReactNode } from 'react';
import Link from 'next/link';

import '../overview/shell.css';
import './docs-shell.css';

import { DOCS_NAV } from './docs-nav';

/**
 * Shared chrome for the conceptual/task-oriented `/docs` hub — Getting Started, Core
 * Concepts, Workflows, etc. Reuses the same STAK Final Contract tokens as the other
 * public-facing shells (loaded via `../overview/shell.css`'s `.stak` class) and follows
 * `_components/app-sidebar.tsx`'s Link/className pattern (one `<Link>` per nav entry,
 * `aria-current="page"` on the active one is handled per-page below since this layout
 * has no access to the current pathname as a server component).
 *
 * `/docs/cli` (built in Task 3) also nests under this layout — its `page.tsx` renders
 * its own `PublicShell` wrapper internally, so that one route currently shows nested
 * chrome. Left as-is here; consolidating `/docs/cli` onto this shell is tracked as a
 * follow-up, not part of this task.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="stak stak-docs">
      <nav className="stak-docs-topnav" aria-label="Memory STAK">
        <Link href="/" className="stak-docs-wordmark">
          Memory STAK
        </Link>
      </nav>
      <div className="stak-docs-frame">
        <nav className="stak-docs-side" aria-label="Documentation">
          <div className="stak-docs-nav">
            {DOCS_NAV.map((entry) => (
              <Link key={entry.href} href={entry.href} className="stak-docs-nav-item">
                {entry.title}
              </Link>
            ))}
          </div>
        </nav>
        <main id="main-content" className="stak-docs-main">
          {children}
        </main>
      </div>
    </div>
  );
}

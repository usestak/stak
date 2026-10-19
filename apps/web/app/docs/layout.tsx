import type { ReactNode } from 'react';
import Link from 'next/link';

import '../overview/shell.css';
import './docs-shell.css';

import { DOCS_NAV } from './docs-nav';

/**
 * Shared chrome for the conceptual/task-oriented `/docs` hub — Getting Started, Core
 * Concepts, Workflows, etc. Reuses the same STAK Final Contract tokens as the other
 * public-facing shells (loaded via `../overview/shell.css`'s `.stak` class) and follows
 * `_components/app-sidebar.tsx`'s Link/className pattern (one `<Link>` per nav entry).
 * This layout is a server component with no access to the current pathname, so
 * `aria-current="page"` on the active nav item is not wired up here; the
 * `.stak-docs-nav-item[aria-current='page']` CSS rule is currently unused.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="stak stak-docs">
      <nav className="stak-docs-topnav" aria-label="Memory STAK">
        <Link href="/" className="stak-docs-wordmark">
          <img
            src="/brand/stak-symbol-dark.svg"
            alt=""
            width={18}
            height={18}
          />
          Memory STAK
        </Link>
      </nav>
      <div className="stak-docs-frame">
        <nav className="stak-docs-side" aria-label="Documentation">
          <div className="stak-docs-nav">
            {DOCS_NAV.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="stak-docs-nav-item"
              >
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

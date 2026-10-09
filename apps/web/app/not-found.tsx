import Link from 'next/link';

import { FocusedShell } from './_components/focused-shell';

/**
 * Global 404 (Next.js special file): catches any unmatched route, and any in-app
 * notFound() call that has no closer not-found.tsx of its own. Uses the focused-flow
 * shell (no sidebar, no account data required — this can render for signed-out visitors
 * and before session context is known) rather than the signed-in AppSidebar frame.
 */
export default function NotFound() {
  return (
    <FocusedShell title="Page not found">
      <p>
        STAK doesn&apos;t have a page at this address. Nothing was changed on
        your account.
      </p>
      <div className="stak-focus-actions">
        <Link className="stak-btn" href="/">
          Go to STAK home
        </Link>
      </div>
    </FocusedShell>
  );
}

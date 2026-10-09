'use client';

import { FocusedShell } from './_components/focused-shell';

/**
 * Global error boundary (Next.js special file). Must be a Client Component per Next's
 * contract. Receives the thrown error + a reset() to retry rendering the segment, but
 * never surfaces the error's own message/stack/digest to the user — those can contain
 * internal details (hostnames, IPs, provider names, error codes). Uses the focused-flow
 * shell like not-found.tsx: no sidebar/account data required to render safely here.
 */
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <FocusedShell title="Something went wrong">
      <p>
        STAK Cloud ran into a problem showing this page. This is a temporary
        problem, not a change to your data.
      </p>
      <div className="stak-focus-actions">
        <button type="button" className="stak-btn" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </FocusedShell>
  );
}

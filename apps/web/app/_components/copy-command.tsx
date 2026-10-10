'use client';

import { useState } from 'react';

/**
 * Minimal client island (P9 Task 2, public landing shell): a single copy-to-
 * clipboard button for one command line - `onClick` + `navigator.clipboard`.
 * Kept as its own tiny leaf (vercel-composition-patterns: isolate
 * interactivity in a leaf component) so the surrounding hero/section markup
 * stays a Server Component.
 *
 * P9 Task 3 adds a confirmation micro-interaction on top of the existing
 * "Copy" -> "Copied" label flip: a transform-only pop (`.stak-landing-copy
 * --copied` in public-landing-shell.css), using the page's shared fast-
 * feedback timing. `prefers-reduced-motion: reduce` collapses it to a near-
 * instant transition; the label flip itself (the actual confirmation) is
 * unaffected either way.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (insecure context, denied
      // permission). Failing silently is correct here - there's no form
      // state to recover and the command text is still visible to copy
      // by hand.
    }
  };

  return (
    <button
      type="button"
      // P9 Task 3: `.stak-landing-copy--copied` adds a transform-only
      // confirmation pop (see public-landing-shell.css's motion-vocabulary
      // section) - purely a visual accent on top of the label flip below,
      // which already carried the actual confirmation state.
      className={
        copied ? 'stak-landing-copy stak-landing-copy--copied' : 'stak-landing-copy'
      }
      onClick={onCopy}
      aria-label={`Copy command: ${command}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

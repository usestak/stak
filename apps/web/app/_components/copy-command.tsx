'use client';

import { useState } from 'react';

/**
 * Minimal client island (P9 Task 2, public landing shell): a single copy-to-
 * clipboard button for one command line. Not a motion/animation component -
 * just `onClick` + `navigator.clipboard`, matching this task's "Copy-button
 * interactivity is a minimal client island, not motion" constraint. Kept as
 * its own tiny leaf (vercel-composition-patterns: isolate interactivity in a
 * leaf component) so the surrounding hero/section markup stays a Server
 * Component.
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
      className="stak-landing-copy"
      onClick={onCopy}
      aria-label={`Copy command: ${command}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

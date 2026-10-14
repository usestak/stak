'use client';

import { useState } from 'react';

/**
 * Copyable inline CLI command for prose - the signed-in app's counterpart to the
 * landing page's `CopyRow` (a standalone block-level row), sized instead to sit inside
 * a sentence without breaking line-height. A real `<button>`, not a styled span/div, so
 * Enter/Space activation and focus semantics are free. "Copied" feedback is a text
 * swap (never color-only) for ~1.6s, matching `CopyRow`'s timing. Only wrap genuine,
 * verbatim-executable commands with this - statuses, IDs, hashes, filenames, and labels
 * like "Standard"/"Protected" stay plain text.
 */
export function InlineCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    // Clipboard access can fail two ways: a synchronous throw (guarded by
    // try/catch) or an async rejection (guarded by `.catch` - an unawaited
    // try/catch around a promise call never sees a later rejection). Either
    // way the command text is still visible to copy by hand, so this fails
    // silently rather than breaking navigation.
    try {
      navigator.clipboard?.writeText(command)?.catch(() => {});
    } catch {
      // ignore
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      className={
        copied ? 'stak-inline-cmd stak-inline-cmd--copied' : 'stak-inline-cmd'
      }
      onClick={onCopy}
      aria-label={`Copy ${command}`}
    >
      {copied ? 'Copied ✓' : command}
    </button>
  );
}

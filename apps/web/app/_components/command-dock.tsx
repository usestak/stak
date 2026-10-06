'use client';

import { useState } from 'react';

/**
 * Reusable command dock (STAK Final Contract). Shows the exact CLI command, scoped to a named
 * machine ("ON ATLAS"), with Copy. The browser NEVER executes the command or touches local
 * files — this only names and copies the command the user runs in their own terminal.
 */
export function CommandDock({
  machineName,
  command,
  hint,
}: {
  machineName: string;
  command: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable (permissions/insecure context); fail quietly.
    }
  };
  return (
    <div className="stak-dock">
      <span className="scope">ON {machineName.toUpperCase()}</span>
      <span className="cmd">
        <span className="p">$ </span>
        {command}
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
      <button
        type="button"
        className="stak-copy"
        onClick={copy}
        aria-label={`Copy command: ${command}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </div>
  );
}

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
  kind = 'ready',
}: {
  machineName: string;
  command: string;
  hint?: string;
  /** 'template' marks a command that is NOT copy-paste-executable as-is (it still contains a
   *  placeholder like <directory> the user must fill in before running it). Ready-to-run and
   *  template commands must never look alike — this drives a visible "Template" badge and a
   *  muted command color so a template is never mistaken for something safe to run verbatim. */
  kind?: 'ready' | 'template';
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
  const isTemplate = kind === 'template';
  return (
    <div className={`stak-dock${isTemplate ? ' stak-dock--template' : ''}`}>
      <span className="scope">ON {machineName.toUpperCase()}</span>
      {isTemplate ? <span className="stak-dock-badge">Template</span> : null}
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

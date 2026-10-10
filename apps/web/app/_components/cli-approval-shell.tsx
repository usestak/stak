import type { ReactNode } from 'react';

import '../overview/shell.css';
import './cli-approval-shell.css';

/**
 * The CLI device-authorization screen (STAK Final Contract S.02, P9 Task 4).
 *
 * The Final Contract mock shows a "Machine" row ("Atlas") and a "System" row
 * ("macOS 15.1 · arm64") inside the fact card. Neither exists on the real
 * `CliAuthSessionRecord` (packages/cloud-server/src/repository.ts) — there is no
 * platform/arch/hostname field anywhere, and the CLI never auto-detects one. The
 * record carries `label`, an optional free-text string the CLI user types with
 * `stak login --label "..."` — it is not a verified device identity, so this shell
 * never renders it under a "Machine"/"System" framing that implies more certainty
 * than exists. Decision: render a `label` row (literally titled "Label") only when
 * `label` is present, and never render a "Machine" or "System" row at all, ever. The
 * `code` row is the one fact this screen is actually sure of (it's the same code the
 * terminal printed), so it's the only row shown unconditionally.
 *
 * There is also no server-side "deny" action (`approveCliAuth` in
 * packages/cloud-server/src/service.ts only ever approves or throws). So "This wasn't
 * me" is wired as a plain link to `/` — it never claims to have told the server
 * anything — see the `declineHref`/`declineLabel` props on {@link CliApprovalCard}.
 */
export function CliApprovalShell({
  code,
  waiting = false,
  children,
}: {
  /** The real user code, shown in both panes verbatim. Omit only when there is none yet. */
  code?: string;
  /** Shows the blinking "Waiting…" terminal line — only true for the live pending state. */
  waiting?: boolean;
  children: ReactNode;
}) {
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
      <div className="stak stak-cli">
        <div className="stak-cli-term">
          <div className="stak-cli-term-brand">STAK</div>
          <div className="stak-cli-term-eyebrow">IN YOUR TERMINAL</div>
          <div className="stak-cli-term-cmd">
            <span>$ </span>stak login
          </div>
          {code ? (
            <div className="stak-cli-term-status">
              Approve this machine in your browser.
              <br />
              Code:{' '}
              <span className="stak-cli-term-code">{code}</span>
              {waiting ? (
                <>
                  <br />
                  Waiting&hellip; <span className="stak-cli-cursor">▍</span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <main id="main-content" className="stak-cli-main">
          {children}
        </main>
      </div>
    </>
  );
}

/** The centered card: heading, context copy, optional fact rows, actions, safety copy. */
export function CliApprovalCard({
  heading,
  sub,
  code,
  label,
  children,
}: {
  heading: string;
  sub?: ReactNode;
  code?: string;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div className="stak-cli-card">
      <div className="stak-cli-head">
        <h1>{heading}</h1>
        {sub ? <p className="stak-cli-sub">{sub}</p> : null}
      </div>
      {code ? (
        <div className="stak-cli-facts">
          {label ? (
            <div className="stak-cli-facts-row">
              <span>Label</span>
              <span className="stak-cli-facts-label">{label}</span>
            </div>
          ) : null}
          <div className="stak-cli-facts-row">
            <span>Code in your terminal</span>
            <span className="stak-cli-facts-code">{code}</span>
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}

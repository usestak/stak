import type { Metadata } from 'next';
import Link from 'next/link';

import {
  PUBLIC_BETA_INSTALL_COMMAND,
  PUBLIC_BETA_VERSION,
} from '../../lib/beta';

export const metadata: Metadata = {
  title: 'Public Beta',
  description:
    'What to expect from the STAK Public Beta — what works, what we want tested, and known limitations.',
};

export default function BetaPage() {
  return (
    <main>
      <h1>Public Beta — {PUBLIC_BETA_VERSION}</h1>
      <p>
        STAK is in a developer Public Beta. The core workflow — carrying Skills
        and Memory across machines with a Git-like flow — is stable enough to
        use daily; some edges are still being sharpened.
      </p>

      <h2>Install</h2>
      <pre>
        <code>{PUBLIC_BETA_INSTALL_COMMAND}</code>
      </pre>

      <h2>What&apos;s ready</h2>
      <ul>
        <li>
          Daily workflow: <code>stak status</code>, <code>stak add .</code>,{' '}
          <code>stak push</code>.
        </li>
        <li>
          Moving to another machine: <code>stak login</code>,{' '}
          <code>stak pull</code>.
        </li>
        <li>Skills move across Claude Code, Cursor, and Codex.</li>
        <li>
          During the public beta, Project Memory portability supports Claude
          Code.
        </li>
      </ul>

      <h2>What we particularly want tested</h2>
      <ul>
        <li>
          Restoring Memory on a fresh machine with <code>stak project</code> and{' '}
          <code>stak memory restore</code>.
        </li>
        <li>
          Mapping local-only Projects with <code>stak project map</code>.
        </li>
        <li>
          Using <code>stak try</code> and <code>stak use</code> with public
          STAKs.
        </li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>
          Project Memory portability currently targets Claude Code, not Cursor
          or Codex.
        </li>
        <li>
          Some Projects can require explicit <code>stak project map</code> when
          identity can&apos;t be proven automatically.
        </li>
        <li>
          STAK deliberately fails closed on a conflicting Memory restore rather
          than overwriting it.
        </li>
        <li>CLI and Cloud semantics may continue evolving during the beta.</li>
      </ul>

      <h2>Feedback</h2>
      <p>
        Tell us what was confusing, what broke, or what you expected STAK to do
        that it didn&apos;t — it directly shapes the beta.{' '}
        <Link href="/feedback">Send feedback</Link>.
      </p>
    </main>
  );
}

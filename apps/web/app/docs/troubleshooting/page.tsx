import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Troubleshooting',
  description:
    'Fixes for the most common STAK problems: a missing agent CLI, login issues, missing Skills, Project mapping conflicts, recovery, Cursor login, and OS-specific quirks.',
};

export default function DocsTroubleshootingPage() {
  return (
    <>
      <h1>Troubleshooting</h1>
      <p>
        Common problems and the direct fix. For full command syntax, see the{' '}
        <Link href="/docs/cli">CLI Reference</Link>.
      </p>

      <h2>Agent not installed</h2>
      <p>
        <code>stak run</code> and <code>stak try</code> launch each agent's own
        CLI on your <code>PATH</code> — Codex's <code>codex</code>, Claude
        Code's CLI, or Cursor's Agent CLI (<code>agent</code>). STAK does not
        install these for you. If a run fails with the agent not found, install
        that agent's CLI first and confirm it resolves on your <code>PATH</code>{' '}
        before retrying.
      </p>

      <h2>STAK login</h2>
      <p>
        Commands that touch Cloud state — Memory backup/restore, Project pull —
        require a signed-in session. If a command reports you're not signed in,
        run:
      </p>
      <pre>
        <code>stak login</code>
      </pre>
      <p>
        If sign-in itself fails, check your network connection and retry; STAK
        does not cache or fall back to stale credentials.
      </p>

      <h2>Missing Skills</h2>
      <p>
        If an agent doesn't see Skills you expect, first confirm they're
        actually part of your desired Environment:
      </p>
      <pre>
        <code>{`stak status\nstak diff`}</code>
      </pre>
      <p>
        If a Skill is missing from <code>main</code> itself, re-add it with{' '}
        <code>stak use</code>. If it's in <code>main</code> but not showing up
        for a specific agent, re-run <code>stak run &lt;agent&gt;</code> to
        reconcile Skills into that agent's directory again.
      </p>

      <h2>Project mapping</h2>
      <p>
        Mapping a Project to a local directory is refused when that directory
        already belongs to a different repository or a different logical Project
        — this is intentional, not a bug. See{' '}
        <Link href="/docs/memory">Memory &amp; Projects</Link> for why a
        directory is only ever a machine-specific binding. Review recovered
        Projects and pick an unambiguous destination directory:
      </p>
      <pre>
        <code>{`stak project\nstak project map my-app ~/code/my-app`}</code>
      </pre>

      <h2>Recovery</h2>
      <p>
        <code>stak memory restore</code> never overwrites an existing target — a
        differing existing target is reported as a conflict and left untouched,
        never merged over. Resolve the conflict manually (move or remove the
        conflicting local file) and re-run restore.
      </p>
      <pre>
        <code>stak memory restore</code>
      </pre>

      <h2>Cursor login</h2>
      <p>
        As of 0.1.1, isolated trials (<code>stak try … -- cursor</code>)
        automatically detect and reuse a normal Cursor <code>agent login</code>{' '}
        session — if you're already signed in to Cursor that way, no extra setup
        is needed inside the trial. Setting <code>CURSOR_API_KEY</code> or{' '}
        <code>CURSOR_AUTH_TOKEN</code> remains available as an optional
        alternative for environments without an interactive{' '}
        <code>agent login</code> session, but it is not required.
      </p>
      <p>
        Also as of 0.1.1, resolving the Cursor Agent CLI on Windows — including
        Cursor's shims — is handled automatically by{' '}
        <code>stak run cursor</code> and <code>stak try … -- cursor</code>; you
        do not need to point STAK at the shim manually.
      </p>

      <h2>Common OS issues</h2>
      <p>
        Skill projection and <code>try</code> isolation both depend on each
        agent's own config directory conventions (for example{' '}
        <code>CODEX_HOME</code>, <code>CLAUDE_CONFIG_DIR</code>, and{' '}
        <code>CURSOR_CONFIG_DIR</code> — see{' '}
        <Link href="/docs/agents">Agents</Link>). If an agent behaves
        differently than expected on your machine, confirm that agent's CLI runs
        correctly outside STAK first — most environment issues are in the
        underlying agent install, not STAK's reconciliation.
      </p>
    </>
  );
}

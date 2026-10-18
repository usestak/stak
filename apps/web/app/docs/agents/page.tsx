import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Agents',
  description:
    'Per-agent setup for Codex, Claude Code, and Cursor: Skill projection, running, isolated trials, and authentication.',
};

export default function DocsAgentsPage() {
  return (
    <>
      <h1>Agents</h1>
      <p>
        Codex, Claude Code, and Cursor are first-class, equally-supported agents
        in STAK — none is a primary integration with the others bolted on. Each
        section below covers the same four things for its agent: Skill
        projection, normal <code>run</code>, isolated <code>try</code>, and
        authentication.
      </p>

      <h2>Codex</h2>
      <h3>Skill projection/binding</h3>
      <p>
        <code>stak run codex</code> reconciles <code>main</code> into Codex's
        Skill directory, protecting unmanaged content and removing only healthy
        STAK-owned bindings.
      </p>
      <h3>Normal run</h3>
      <p>
        Launches the Codex CLI (<code>codex</code> on your <code>PATH</code>)
        with the reconciled Skills projected — not the ChatGPT desktop app.
      </p>
      <pre>
        <code>stak run codex</code>
      </pre>
      <h3>Isolated try</h3>
      <p>
        Runs Codex in a temporary <code>CODEX_HOME</code>; <code>main</code> and
        your normal Codex bindings are untouched and the trial runtime is
        cleaned up afterward.
      </p>
      <pre>
        <code>stak try @owner/name -- codex</code>
      </pre>
      <h3>Authentication expectations</h3>
      <p>
        Codex's own CLI handles its sign-in; STAK only reconciles Skills and
        launches it, so sign in to Codex the same way you would outside STAK.
      </p>

      <h2>Claude Code</h2>
      <h3>Skill projection/binding</h3>
      <p>
        <code>stak run claude</code> reconciles <code>main</code> into Claude
        Code's Skill directory, protecting unmanaged content and removing only
        healthy STAK-owned bindings.
      </p>
      <h3>Normal run</h3>
      <p>Launches the Claude Code CLI with the reconciled Skills projected.</p>
      <pre>
        <code>stak run claude</code>
      </pre>
      <h3>Isolated try</h3>
      <p>
        Runs Claude Code in a temporary <code>CLAUDE_CONFIG_DIR</code>;{' '}
        <code>main</code> and your normal Claude Code bindings are untouched and
        the trial runtime is cleaned up afterward.
      </p>
      <pre>
        <code>stak try @owner/name -- claude</code>
      </pre>
      <h3>Authentication expectations</h3>
      <p>
        Claude Code's own CLI handles its sign-in; STAK only reconciles Skills
        and launches it, so sign in to Claude Code the same way you would
        outside STAK.
      </p>

      <h2>Cursor</h2>
      <h3>Skill projection/binding</h3>
      <p>
        <code>stak run cursor</code> reconciles <code>main</code> into Cursor's
        Skill directory, protecting unmanaged content and removing only healthy
        STAK-owned bindings. The official Cursor Agent CLI may be invoked as{' '}
        <code>agent</code>.
      </p>
      <h3>Normal run</h3>
      <p>Launches Cursor's agent CLI with the reconciled Skills projected.</p>
      <pre>
        <code>stak run cursor</code>
      </pre>
      <h3>Isolated try</h3>
      <p>
        Runs Cursor in a temporary <code>CURSOR_CONFIG_DIR</code>;{' '}
        <code>main</code> and your normal Cursor bindings are untouched and the
        trial runtime is cleaned up afterward.
      </p>
      <pre>
        <code>stak try @owner/name -- cursor</code>
      </pre>
      <h3>Authentication expectations</h3>
      <p>
        Isolated trials support a normal <code>agent login</code> session — if
        you're already signed in to Cursor that way, it's detected and reused
        automatically, no extra setup needed. You do not need to configure{' '}
        <code>CURSOR_API_KEY</code> to use STAK with Cursor; it's only an
        optional alternative, available as <code>CURSOR_API_KEY</code> or{' '}
        <code>CURSOR_AUTH_TOKEN</code>, for environments without an interactive{' '}
        <code>agent login</code> session.
      </p>

      <p>
        See <Link href="/docs/cli">CLI Reference</Link> for every flag on{' '}
        <code>run</code> and <code>try</code>, and{' '}
        <Link href="/docs/workflows">Workflows</Link> for the full task
        sequences these commands fit into.
      </p>
    </>
  );
}

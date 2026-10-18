import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Getting Started',
  description:
    'What STAK is, how to install the CLI, and how to run your first STAK with Codex, Claude Code, or Cursor.',
};

export default function DocsGettingStartedPage() {
  return (
    <>
      <h1>Getting Started</h1>
      <p>
        Memory STAK is currently in beta. The CLI and Cloud model are actively
        evolving.
      </p>

      <h2>Introduction</h2>
      <p>
        STAK gives you portable Skills, private Memory, and repeatable setup
        across the AI coding agents you already use. Instead of re-teaching each
        agent your conventions by hand on every machine, you capture that setup
        once and bring it with you — to a new machine, a new project, or a
        different agent entirely.
      </p>

      <h2>What is STAK?</h2>
      <p>STAK is built from a small set of ideas:</p>
      <ul>
        <li>
          <strong>Skills</strong> — individual capabilities an agent can use
          (instructions, context, tools).
        </li>
        <li>
          <strong>STAKs</strong> — named, versioned bundles of Skills you can
          add to a machine or share publicly.
        </li>
        <li>
          <strong>Memory</strong> — private, Cloud-backed context for an agent
          that is never included when you publish a STAK.
        </li>
        <li>
          <strong>Projects</strong> — a stable logical identity in STAK Cloud;
          the local directory on your machine is just that machine's binding to
          it.
        </li>
        <li>
          <strong>Machines</strong> — the individual computers where you run
          agents and reconcile Skills.
        </li>
      </ul>
      <p>
        See <Link href="/docs/concepts">Core Concepts</Link> for the full detail
        on each.
      </p>

      <h2>Install STAK</h2>
      <p>Install the CLI globally, then sign in to STAK Cloud:</p>
      <pre>
        <code>{`npm install -g @memstk/cli\nstak login`}</code>
      </pre>

      <h2>Your first STAK</h2>
      <p>
        The fastest way to try a STAK is in an isolated, temporary runtime that
        never touches your normal agent setup:
      </p>
      <pre>
        <code>stak try @stephentony100/frontend-test -- claude</code>
      </pre>
      <p>
        <code>stak try</code> launches Claude Code with that STAK's Skills
        projected into a temporary environment. Your real <code>main</code>{' '}
        desired state, your normal agent bindings, and any permanent agent state
        are untouched — the trial runtime is cleaned up afterward.
      </p>
      <p>
        If you want to keep using a STAK going forward, add it to{' '}
        <code>main</code> and then launch an agent against it:
      </p>
      <pre>
        <code>{`stak use @stephentony100/frontend-test\nstak run codex`}</code>
      </pre>
      <p>
        These are two distinct steps with two distinct effects.{' '}
        <code>stak use</code> only resolves and verifies that STAK's Skills and
        adds them to your main desired state — it does <strong>not</strong>{' '}
        launch an agent. <code>stak run codex</code> (or <code>claude</code>, or{' '}
        <code>cursor</code>) is the step that projects <code>main</code> into
        that agent's Skill directory and launches it. See{' '}
        <Link href="/docs/cli">CLI Reference</Link> for every command and flag.
      </p>

      <h2>Using STAK with Codex, Claude Code, and Cursor</h2>
      <p>
        Codex, Claude Code, and Cursor are first-class, equally-supported agents
        in STAK — none is a primary integration with the others bolted on.
      </p>
      <p>
        <strong>Codex</strong> — <code>stak run codex</code> reconciles{' '}
        <code>main</code> into Codex's Skill directory and launches the Codex
        CLI on your PATH.
      </p>
      <p>
        <strong>Claude Code</strong> — <code>stak run claude</code> does the
        same for Claude Code's CLI.
      </p>
      <p>
        <strong>Cursor</strong> — <code>stak run cursor</code> does the same for
        Cursor's agent CLI.
      </p>
      <p>
        All three also work with{' '}
        <code>stak try &lt;stak&gt; -- codex|claude|cursor</code> for isolated
        trials. See <Link href="/docs/agents">Agents</Link> for per-agent setup
        and authentication notes.
      </p>
    </>
  );
}

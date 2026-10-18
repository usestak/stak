import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Workflows',
  description:
    'Task-oriented walkthroughs for the STAK CLI: discovering Skills, using and trying STAKs, running agents, publishing, and backing up or recovering Memory.',
};

export default function DocsWorkflowsPage() {
  return (
    <>
      <h1>Workflows</h1>
      <p>
        Short, task-oriented sequences for the things you actually do with STAK.
        Each one names the real command — for every option and flag, see the{' '}
        <Link href="/docs/cli">CLI Reference</Link>.
      </p>

      <h2>Discover existing Skills</h2>
      <p>
        Before capturing a desired state, see what Skills already exist across
        your agent roots. This is read-only and changes nothing.
      </p>
      <pre>
        <code>stak scan</code>
      </pre>

      <h2>Create main</h2>
      <p>
        Capture the Skills currently installed globally as your desired
        Environment, <code>main</code>. Every later <code>run</code>,{' '}
        <code>status</code>, or <code>diff</code> compares against this.
      </p>
      <pre>
        <code>stak init</code>
      </pre>

      <h2>Use a STAK</h2>
      <p>
        Add a STAK layer — local path or public <code>@owner/name</code> — to{' '}
        <code>main</code>. This only updates desired state; it does not launch
        an agent.
      </p>
      <pre>
        <code>stak use @owner/name</code>
      </pre>

      <h2>Try a STAK safely</h2>
      <p>
        Run a STAK in an isolated, temporary runtime without touching{' '}
        <code>main</code>, your normal agent bindings, or any permanent agent
        state. The trial runtime is cleaned up afterward.
      </p>
      <pre>
        <code>stak try @owner/name -- codex</code>
      </pre>

      <h2>Run an agent</h2>
      <p>
        Reconcile <code>main</code> into an agent's Skill directory and launch
        that agent's CLI with the Skills projected.
      </p>
      <pre>
        <code>stak run claude</code>
      </pre>

      <h2>Publish a STAK</h2>
      <p>
        Publish a reference-only public STAK as <code>@owner/name</code> from a
        local source or an active local layer.
      </p>
      <pre>
        <code>stak publish ./my-stak --slug my-stak</code>
      </pre>

      <h2>Update a published STAK</h2>
      <p>
        There is no automatic update in V0.1 — an already-active public STAK is
        never silently upgraded. Check each Skill's source for newer versions,
        then re-run <code>use</code> to pick them up.
      </p>
      <pre>
        <code>{`stak skill check\nstak use @owner/name`}</code>
      </pre>

      <h2>Back up Memory</h2>
      <p>
        Copy allowlisted Memory into STAK's private store. This is a read-only
        capture — native agent memory files are never modified.
      </p>
      <pre>
        <code>stak memory backup</code>
      </pre>

      <h2>Recover Memory</h2>
      <p>
        <code>stak memory recover</code> downloads your private memory store
        from STAK Cloud; <code>stak memory restore</code> then writes it into
        native agent Memory on this machine. Existing targets are never
        overwritten — a differing existing target is reported as a conflict and
        left untouched.
      </p>
      <pre>
        <code>{`stak memory recover\nstak memory restore`}</code>
      </pre>

      <h2>Map recovered Projects</h2>
      <p>
        Recovered Memory surfaces as logical Projects. Review them, then
        authorize a local directory as the restore destination for one — this is
        a local binding only, never shared as part of the Project's identity.
      </p>
      <pre>
        <code>{`stak project\nstak project map my-app ~/code/my-app`}</code>
      </pre>

      <h2>Move/use STAK on another machine</h2>
      <p>
        On a new machine, sign in and reconstruct <code>main</code> from STAK
        Cloud before reconciling it into an agent. See{' '}
        <Link href="/docs/memory">Memory &amp; Projects</Link> for how Project
        identity and Memory follow you across machines.
      </p>
      <pre>
        <code>{`stak login\nstak pull\nstak run claude`}</code>
      </pre>
    </>
  );
}

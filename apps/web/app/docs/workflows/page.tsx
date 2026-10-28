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

      <h2>See what changed</h2>
      <p>
        Read-only — compares this machine against <code>main</code>. Nothing
        moves yet.
      </p>
      <pre>
        <code>stak status</code>
      </pre>

      <h2>Choose what belongs in main</h2>
      <p>
        Stage the Skills and Memory you want to keep in <code>main</code>.
      </p>
      <pre>
        <code>stak add .</code>
      </pre>

      <h2>Sync it</h2>
      <p>
        Synchronize staged <code>main</code> Skills and Memory to STAK Cloud.
      </p>
      <pre>
        <code>stak push</code>
      </pre>

      <h2>Discover existing Skills</h2>
      <p>
        A diagnostic, read-only discovery across agent Skill roots — not where
        the daily workflow starts (that&apos;s <code>stak status</code>).
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
        Publish a public STAK as <code>@owner/name</code> from a local source or
        an active local layer.
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
        capture — native agent memory files are never modified. This is the
        explicit, manual backup command — the normal <code>stak push</code> flow
        already syncs staged Memory; use this when you want an out-of-band
        backup.
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
        left untouched. This is explicit, history-based recovery — not part of
        the normal new-machine flow, which uses <code>stak pull</code> instead
        (see below).
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

      <h2>Move to another machine</h2>
      <p>
        On a new machine, sign in and pull — this restores <code>main</code>,
        Skills, and your latest staged private Memory generation:
      </p>
      <pre>
        <code>{`stak login\nstak pull\nstak status`}</code>
      </pre>
      <p>
        Pull does not touch your agents, so <code>stak status</code> lists the
        pulled Skills as not installed here yet. Set them up in an agent:
      </p>
      <pre>
        <code>{`stak run codex`}</code>
      </pre>
      <p>If you use Claude Code, materialize recovered Memory into it:</p>
      <pre>
        <code>{`stak project\nstak memory restore --dry-run\nstak memory restore`}</code>
      </pre>
      <p>
        <code>stak memory recover</code> remains available for explicit or
        history-based recovery (see <Link href="/docs/cli">CLI Reference</Link>)
        but is not part of this normal flow.
      </p>
    </>
  );
}

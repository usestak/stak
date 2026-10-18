import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Memory & Projects',
  description:
    'How Memory works, how Project identity stays stable across machines, and how to back up, recover, and move Memory.',
};

export default function DocsMemoryPage() {
  return (
    <>
      <h1>Memory &amp; Projects</h1>
      <p>
        Memory is private, Cloud-backed state — separate from Skills, and
        never implied to be part of a public STAK. See{' '}
        <Link href="/docs/sharing">Sharing</Link> for the full boundary of
        what a published STAK does and does not contain.
      </p>

      <h2>How Memory works</h2>
      <p>
        Memory is an agent's accumulated private context on this machine.
        STAK can discover it, back it up into its own private store, and
        later restore it — all read-only with respect to your agent's
        native files; backup never modifies them.
      </p>
      <pre>
        <code>{`stak memory scan\nstak memory backup\nstak memory status`}</code>
      </pre>

      <h2>Stable logical Project identity</h2>
      <p>
        A Project is a stable logical identity in STAK Cloud, derived from
        recovered Memory — not a folder. Renaming or moving the local
        directory you work in never changes a Project's identity; the
        directory is only ever a machine-specific binding to it.
      </p>
      <pre>
        <code>stak project</code>
      </pre>

      <h2>Local machine mappings</h2>
      <p>
        Mapping a Project to a directory authorizes that directory as the
        restore destination for it on this machine. The mapping is local
        only — the path is never shared as the Project's identity, and is
        refused when the directory already belongs to a different
        repository or a different logical Project.
      </p>
      <pre>
        <code>stak project map my-app ~/code/my-app</code>
      </pre>

      <h2>Backup/recovery</h2>
      <p>
        Back up when you want Memory durably stored; restore writes only
        absent targets — a differing existing target is reported as a
        conflict and left untouched, never merged over.
      </p>
      <pre>
        <code>{`stak memory backup\nstak memory restore`}</code>
      </pre>

      <h2>Moving to another computer</h2>
      <p>
        On a new machine, sign in, reconstruct your desired Environment, and
        recover Memory. Logical Projects reappear from recovered Memory, and
        you map each one to wherever it lives locally on that machine —
        Project identity itself never moves, only the binding does.
      </p>
      <pre>
        <code>{`stak login\nstak pull\nstak memory restore\nstak project map my-app ~/code/my-app`}</code>
      </pre>
    </>
  );
}

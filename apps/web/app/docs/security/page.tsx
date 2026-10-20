import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security & Privacy',
  description:
    'What stays on your machine, what is Cloud-backed, exactly what a public STAK contains, and the isolation guarantees behind stak try.',
};

export default function DocsSecurityPage() {
  return (
    <>
      <h1>Security &amp; Privacy</h1>
      <p>
        This page is the full privacy model behind STAK: what lives only on your
        machine, what is Cloud-backed, what a public STAK contains, and the
        isolation guarantees you get when trying one.
      </p>

      <h2>Local state</h2>
      <p>
        Your desired Environment (<code>main</code>), Skill directories for each
        agent, and local Project mappings all live on this machine. Local
        Project mappings in particular are a machine-specific binding only — see{' '}
        <Link href="/docs/memory">Memory &amp; Projects</Link> — and are never
        uploaded or published as part of a Project's identity.
      </p>

      <h2>Cloud state</h2>
      <p>
        Memory and logical Project identity are private, Cloud-backed state.
        Cloud storage is what lets Memory and Projects follow you across
        machines — sign in on a new machine, run <code>stak pull</code>, which
        also restores your latest staged private Memory generation;{' '}
        <code>stak memory recover</code> remains available for explicit/history
        recovery — see <Link href="/docs/workflows">Workflows</Link> for the
        current sequence.
      </p>

      <h2>Public STAK contents</h2>
      <p>
        A published STAK contains only portable Skill snapshots — instructions,
        context, and tool definitions, stripped of anything machine- or
        account-specific. That is the entire payload. See{' '}
        <Link href="/docs/sharing">Sharing</Link> for the complete list of what
        is and is never included.
      </p>

      <h2>Credentials</h2>
      <p>
        Tokens, API keys, and other auth state are never read, stored in, or
        published with a STAK. Each agent's CLI handles its own sign-in
        independently of STAK; STAK only reconciles Skills and launches the
        agent.
      </p>

      <h2>Memory privacy</h2>
      <p>
        Memory is private, Cloud-backed state — separate from Skills, and never
        implied to be part of a public STAK. Backing up Memory is read-only with
        respect to your agent's native files: it copies allowlisted Memory into
        STAK's own private store and never modifies the originals.
      </p>

      <h2>Isolation guarantees</h2>
      <p>
        <code>stak try</code> runs a STAK in an isolated, temporary runtime. It
        does not mutate <code>main</code>, your normal agent bindings, or any
        permanent agent state, and the trial runtime is cleaned up afterward.
        That is the full isolation guarantee — nothing a STAK does inside a
        trial persists once it ends.
      </p>
      <pre>
        <code>stak try @owner/name -- codex</code>
      </pre>
    </>
  );
}

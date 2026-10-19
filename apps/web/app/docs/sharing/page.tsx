import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sharing',
  description:
    'What a public STAK is, what it contains, how versioning works, and exactly what is — and is never — published.',
};

export default function DocsSharingPage() {
  return (
    <>
      <h1>Sharing</h1>
      <p>
        Publishing is a deliberate, separate step from using a STAK locally.
        This page is the precise boundary of what leaves your machine when you
        run <code>stak publish</code>.
      </p>

      <h2>Public STAKs</h2>
      <p>
        A public STAK is a named, versioned bundle published as{' '}
        <code>@owner/name</code>. Every Skill in the bundle publishes the same
        way: as an immutable, content-addressed snapshot pinned by content hash.
        That holds whether or not the Skill has a git-tracked source — a
        consumer never needs the original repository to exist to use a published
        STAK. When a Skill does have a git-tracked source, its
        remote/revision/path are preserved as display and update-check metadata,
        but they are never required for restoration. The only requirement to
        publish is that you&apos;ve run <code>stak push</code> for that content
        first; otherwise publishing fails with an actionable error. This applies
        equally when publishing or sharing a Skill from the web — if it
        hasn&apos;t been uploaded to STAK Cloud yet, run <code>stak push</code>{' '}
        first. Anyone can <code>stak use</code> or <code>stak try</code> a
        published STAK; using it never grants write access back to your account
        or machine.
      </p>
      <pre>
        <code>stak publish ./my-stak --slug my-stak</code>
      </pre>

      <h2>Portable Skill snapshots</h2>
      <p>
        What actually gets published is a portable snapshot of the Skills in
        that STAK — the instructions, context, and tooling definitions
        themselves, stripped of anything specific to your machine or account.
        That's the entire payload of a public STAK.
      </p>

      <h2>Versioning</h2>
      <p>
        Each publish is a distinct version. There is no automatic update
        mechanism: an already-active public STAK on someone's machine is never
        silently upgraded to a newer version. Consumers re-run{' '}
        <code>stak use</code> explicitly when they want to pick up changes.
      </p>

      <h2>What gets shared</h2>
      <ul>
        <li>
          The STAK's name and published slug (<code>@owner/name</code>).
        </li>
        <li>
          The portable Skill snapshots that make up that STAK's version —
          instructions, context, and tool definitions.
        </li>
      </ul>

      <h2>What never gets shared</h2>
      <p>
        Public STAKs contain only portable Skill snapshots. They never include:
      </p>
      <ul>
        <li>
          <strong>Memory</strong> — your agent's private, Cloud-backed context
          is never part of a published STAK.
        </li>
        <li>
          <strong>Projects</strong> — logical Project identity and the Memory
          behind a Project are never published.
        </li>
        <li>
          <strong>Machine state</strong> — nothing about which machine a Skill
          was authored or used on travels with it.
        </li>
        <li>
          <strong>Credentials</strong> — tokens, API keys, and auth state are
          never read, stored in, or published with a STAK.
        </li>
        <li>
          <strong>Local filesystem paths</strong> — directory locations on your
          machine, including local Project mappings, are never included.
        </li>
      </ul>
      <p>
        See <Link href="/docs/memory">Memory &amp; Projects</Link> for how
        Memory and Project identity work, and{' '}
        <Link href="/docs/security">Security &amp; Privacy</Link> for the full
        privacy model.
      </p>
    </>
  );
}

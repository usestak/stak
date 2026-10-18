import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Open Source',
  description:
    'Architecture docs, local development, contributing, repository structure, and security reporting for the Memory STAK monorepo.',
};

const GITHUB_BLOB = 'https://github.com/usestak/stak/blob/main';
const GITHUB_TREE = 'https://github.com/usestak/stak/tree/main';

export default function DocsOpenSourcePage() {
  return (
    <>
      <h1>Open Source</h1>
      <p>
        Memory STAK is developed in the open. This page is a map of the
        repository — where the architecture is documented, how to build it
        locally, how to contribute, and how to report a security issue.
      </p>

      <h2>Architecture overview</h2>
      <p>
        Design decisions and deeper technical write-ups live under{' '}
        <a href={`${GITHUB_TREE}/docs/architecture`}>
          <code>docs/architecture/</code>
        </a>{' '}
        (ADRs and design spikes), and the end-to-end system design is in{' '}
        <a href={`${GITHUB_BLOB}/docs/technical-build-spec.md`}>
          <code>docs/technical-build-spec.md</code>
        </a>
        .
      </p>

      <h2>Local development</h2>
      <p>
        Build and run the monorepo locally by following{' '}
        <a href={`${GITHUB_BLOB}/CONTRIBUTING.md`}>
          <code>CONTRIBUTING.md</code>
        </a>{' '}
        at the repository root — it covers prerequisites, install, and the
        local dev workflow.
      </p>

      <h2>Contributing</h2>
      <p>
        Everything from coding conventions to how to open a pull request is
        in the same{' '}
        <a href={`${GITHUB_BLOB}/CONTRIBUTING.md`}>
          <code>CONTRIBUTING.md</code>
        </a>
        . Read it before sending a change.
      </p>

      <h2>Repository structure</h2>
      <p>This is a pnpm/Turborepo monorepo with two top-level groups:</p>
      <ul>
        <li>
          <code>apps/web</code> — the web app, including this documentation
          site.
        </li>
        <li>
          <code>packages/*</code> — the STAK CLI and its libraries:{' '}
          <code>cli</code>, <code>core</code>, <code>adapters</code>,{' '}
          <code>memory</code>, <code>scanner</code>, <code>cloud-client</code>
          , <code>cloud-server</code>, <code>store</code>,{' '}
          <code>shared</code>, and <code>spec</code>.
        </li>
      </ul>

      <h2>Security reporting</h2>
      <p>
        To report a security issue, follow the disclosure process in{' '}
        <a href={`${GITHUB_BLOB}/SECURITY.md`}>
          <code>SECURITY.md</code>
        </a>{' '}
        at the repository root — please don't file public issues for
        security reports.
      </p>
    </>
  );
}

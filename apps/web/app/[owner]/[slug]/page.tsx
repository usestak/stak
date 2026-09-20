import { notFound } from 'next/navigation';

import { isSafeDisplayUrl } from '@stack/spec';

import { getCloudService } from '@/lib/cloud-service';

export const dynamic = 'force-dynamic';

export default async function StackPage({
  params,
}: {
  params: Promise<{ owner: string; slug: string }>;
}) {
  const { owner, slug } = await params;
  if (!owner.startsWith('@')) notFound();
  const handle = owner.slice(1);

  let stack;
  try {
    stack = await getCloudService().getPublicStack(handle, slug);
  } catch {
    notFound();
  }

  const ref = `@${stack.owner}/${stack.slug}`;
  const requirements = stack.latest?.bundle.requirements ?? [];

  return (
    <main>
      <h1>{stack.displayName}</h1>
      <p>
        <code>{ref}</code>
        {stack.latest ? ` · v${stack.latest.version.versionNumber}` : ''}
      </p>
      {stack.description ? <p>{stack.description}</p> : null}

      <h2>Install</h2>
      <pre>
        <code>{`stack use ${ref}`}</code>
      </pre>
      <pre>
        <code>{`stack try ${ref} -- codex`}</code>
      </pre>
      <p>
        Supported agents: Codex, Cursor, Claude Code. Isolated{' '}
        <code>stack try</code> is Codex-only in V0.
      </p>

      <h2>Skills ({requirements.length})</h2>
      {requirements.length === 0 ? (
        <p>This Stack has no published versions yet.</p>
      ) : (
        <ul>
          {requirements.map((requirement) => {
            const reference = requirement.restoration.reference;
            return (
              <li key={requirement.id}>
                <strong>{requirement.name}</strong>
                {requirement.metadata.description ? (
                  <div>{requirement.metadata.description}</div>
                ) : null}
                <div>
                  Source:{' '}
                  {isSafeDisplayUrl(reference.remote) ? (
                    <a
                      href={reference.remote}
                      rel="noopener noreferrer nofollow"
                    >
                      {reference.remote}
                    </a>
                  ) : (
                    <code>{reference.remote}</code>
                  )}{' '}
                  <code>{reference.path}</code> @{' '}
                  <code>{reference.revision.slice(0, 12)}</code>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p>
        Source references are provided by the author. Repository accessibility
        is not verified by Stack.
      </p>
    </main>
  );
}

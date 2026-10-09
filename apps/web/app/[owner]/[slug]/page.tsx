import { notFound } from 'next/navigation';

import { isSafeDisplayUrl } from '@stack/spec';

import { PublicShell } from '@/app/_components/public-shell';
import { getCloudService } from '@/lib/cloud-service';
import { relativeTime, skillCount } from '@/lib/format';

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
    <PublicShell title={stack.displayName}>
      <div className="stak-public-meta">
        <span className="stak-public-ref">{ref}</span>
        <span className="dot">{skillCount(requirements.length)}</span>
        {stack.latest ? (
          <span className="dot">
            Cloud version {stack.latest.version.versionNumber}
          </span>
        ) : null}
        <span className="dot">Updated {relativeTime(stack.updatedAt)}</span>
      </div>
      {stack.description ? (
        <p className="stak-public-muted">{stack.description}</p>
      ) : null}

      <h2>Install</h2>
      <pre className="stak-cmd">
        <code>{`stak use ${ref}\nstak try ${ref} -- codex`}</code>
      </pre>
      <p className="stak-public-muted">
        Supported agents: Codex, Cursor, Claude. Isolated{' '}
        <code>stak try</code> is Codex-only in V0.1.
      </p>

      <h2>Skills</h2>
      {requirements.length === 0 ? (
        <p className="stak-public-muted">
          This Stack has no published versions yet.
        </p>
      ) : (
        <ul className="stak-public-skills">
          {requirements.map((requirement) => {
            const reference = requirement.restoration.reference;
            return (
              <li key={requirement.id}>
                <div className="stak-public-skill-name">
                  {requirement.name}
                </div>
                {requirement.metadata.description ? (
                  <div className="stak-public-skill-desc">
                    {requirement.metadata.description}
                  </div>
                ) : null}
                <div className="stak-public-skill-source">
                  {isSafeDisplayUrl(reference.remote) ? (
                    <a href={reference.remote} rel="noopener noreferrer nofollow">
                      {reference.remote}
                    </a>
                  ) : (
                    reference.remote
                  )}{' '}
                  · {reference.path} @ {reference.revision.slice(0, 12)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="stak-public-muted" style={{ fontSize: '0.82rem', marginTop: '1rem' }}>
        Source references are provided by the author. Repository accessibility
        is not verified by STAK.
      </p>
    </PublicShell>
  );
}

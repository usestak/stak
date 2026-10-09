import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isSafeDisplayUrl } from '@stack/spec';

import { PublicShell } from '@/app/_components/public-shell';
import { getCloudService } from '@/lib/cloud-service';
import { relativeTime, skillCount } from '@/lib/format';
import { siteOrigin } from '@/lib/site-origin';

export const dynamic = 'force-dynamic';

/**
 * Fields come from `getPublicStackResponseSchema` (packages/spec/src/public.ts),
 * re-traced here rather than trusting Task 4's page-body audit as-is, since
 * metadata can expose more than markup: `owner` (handle), `slug`,
 * `displayName`, `description`, `updatedAt`, and `latest.version.versionNumber`
 * / `latest.bundle.requirements.length` are all already rendered on the page
 * body and contain no snapshot contents, local filesystem paths, content
 * hashes, or credentials. Explicitly NOT used here: `stackId` (internal uuid),
 * `latest.version.versionHash`/`digest` (content hashes), and any requirement
 * `restoration.reference` detail (source remote/path/revision) — none of
 * those belong in a page `<title>`/description even though some render in
 * the page body as plain reference text.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; slug: string }>;
}): Promise<Metadata> {
  const { owner, slug } = await params;
  if (!owner.startsWith('@'))
    return { robots: { index: false, follow: false } };
  const handle = owner.slice(1);

  let stack;
  try {
    stack = await getCloudService().getPublicStack(handle, slug);
  } catch {
    return { robots: { index: false, follow: false } };
  }

  const url = `${siteOrigin()}/@${stack.owner}/${stack.slug}`;
  const title = `${stack.displayName} by @${stack.owner} | STAK`;
  const requirementCount = stack.latest?.bundle.requirements.length ?? 0;
  const description = stack.description
    ? stack.description
    : stack.latest
      ? `A STAK Stack with ${skillCount(requirementCount)}, shared by @${stack.owner}.`
      : `@${stack.owner} has not published a version of this Stack yet.`;
  // Indexable only once the Stack has a real published version — an empty
  // Stack ("no published versions yet") is thin content and stays noindex.
  const index = stack.latest !== null;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url },
    robots: { index, follow: index },
  };
}

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
        Supported agents: Codex, Cursor, Claude. Isolated <code>stak try</code>{' '}
        is Codex-only in V0.1.
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
                <div className="stak-public-skill-name">{requirement.name}</div>
                {requirement.metadata.description ? (
                  <div className="stak-public-skill-desc">
                    {requirement.metadata.description}
                  </div>
                ) : null}
                <div className="stak-public-skill-source">
                  {isSafeDisplayUrl(reference.remote) ? (
                    <a
                      href={reference.remote}
                      rel="noopener noreferrer nofollow"
                    >
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
      <p
        className="stak-public-muted"
        style={{ fontSize: '0.82rem', marginTop: '1rem' }}
      >
        Source references are provided by the author. Repository accessibility
        is not verified by STAK.
      </p>
    </PublicShell>
  );
}

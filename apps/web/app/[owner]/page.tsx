import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

import { PublicShell } from '@/app/_components/public-shell';
import { getCloudService } from '@/lib/cloud-service';
import { relativeTime } from '@/lib/format';
import { siteOrigin } from '@/lib/site-origin';

export const dynamic = 'force-dynamic';

/**
 * Only fields already surfaced on the page body (and traced to
 * `publicProfileResponseSchema` in packages/spec) go into metadata:
 * `owner` (handle), `displayName` (optional author-chosen name), and each
 * listed Stack's `slug`/`displayName`/`description`/`latestVersionNumber`.
 * No snapshot contents, local paths, hashes, or credentials ever reach this
 * response shape, so there is nothing unsafe to filter out here.
 *
 * Indexable only when the profile has at least one public Stack listed —
 * an empty profile ("No public Stacks yet.") is thin content and stays
 * noindex even though it resolves successfully (it is not the Task 6
 * not-found case, which is handled by `notFound()` below and already
 * excluded from indexing by Next.js).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string }>;
}): Promise<Metadata> {
  const { owner: handle } = await params;

  let profile;
  try {
    profile = await getCloudService().getPublicProfile(handle);
  } catch {
    return { robots: { index: false, follow: false } };
  }

  // Canonical browser URL: `/owner`, never the `@owner` CLI locator form.
  const url = `${siteOrigin()}/${profile.owner}`;
  const title = profile.displayName
    ? `${profile.displayName} (@${profile.owner}) | Memory STAK`
    : `@${profile.owner} | Memory STAK`;
  const count = profile.stacks.length;
  const skillCountOnProfile = profile.stacks.filter(
    (stack) => stack.kind === 'skill',
  ).length;
  const stackCountOnProfile = count - skillCountOnProfile;
  const description =
    count > 0
      ? `${[
          stackCountOnProfile > 0
            ? `${stackCountOnProfile} public STAK${stackCountOnProfile === 1 ? '' : 's'}`
            : null,
          skillCountOnProfile > 0
            ? `${skillCountOnProfile} shared Skill${skillCountOnProfile === 1 ? '' : 's'}`
            : null,
        ]
          .filter(Boolean)
          .join(' and ')} from @${profile.owner} on Memory STAK.`
      : `@${profile.owner} has not shared anything yet.`;
  const index = profile.stacks.length > 0;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url },
    robots: { index, follow: index },
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ owner: string }>;
}) {
  const { owner: handle } = await params;

  let profile;
  try {
    profile = await getCloudService().getPublicProfile(handle);
  } catch {
    notFound();
  }

  return (
    <PublicShell title={`@${profile.owner}`}>
      {profile.displayName ? (
        <p className="stak-public-muted">{profile.displayName}</p>
      ) : null}

      <h2>Public STAKs &amp; Skills</h2>
      {profile.stacks.length === 0 ? (
        <p className="stak-public-muted">Nothing public yet.</p>
      ) : (
        profile.stacks.map((stack) => (
          <Link
            key={stack.slug}
            className="stak-public-card"
            href={`/${profile.owner}/${stack.slug}`}
          >
            <div className="stak-public-card-title">
              {stack.displayName}
              {stack.kind === 'skill' ? (
                <span className="stak-public-badge"> Skill</span>
              ) : null}
            </div>
            <div className="stak-public-meta">
              <span className="stak-public-ref">
                @{profile.owner}/{stack.slug}
              </span>
              {stack.latestVersionNumber ? (
                <span className="dot">
                  Cloud version {stack.latestVersionNumber}
                </span>
              ) : null}
              <span className="dot">
                Updated {relativeTime(stack.updatedAt)}
              </span>
            </div>
            {stack.description ? (
              <div
                className="stak-public-muted"
                style={{ marginTop: '0.4rem' }}
              >
                {stack.description}
              </div>
            ) : null}
          </Link>
        ))
      )}
    </PublicShell>
  );
}

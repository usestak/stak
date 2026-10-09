import { notFound } from 'next/navigation';
import Link from 'next/link';

import { PublicShell } from '@/app/_components/public-shell';
import { getCloudService } from '@/lib/cloud-service';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ owner: string }>;
}) {
  const { owner } = await params;
  if (!owner.startsWith('@')) notFound();
  const handle = owner.slice(1);

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

      <h2>Public Stacks</h2>
      {profile.stacks.length === 0 ? (
        <p className="stak-public-muted">No public Stacks yet.</p>
      ) : (
        profile.stacks.map((stack) => (
          <Link
            key={stack.slug}
            className="stak-public-card"
            href={`/@${profile.owner}/${stack.slug}`}
          >
            <div className="stak-public-card-title">{stack.displayName}</div>
            <div className="stak-public-meta">
              <span className="stak-public-ref">
                @{profile.owner}/{stack.slug}
              </span>
              {stack.latestVersionNumber ? (
                <span className="dot">
                  Cloud version {stack.latestVersionNumber}
                </span>
              ) : null}
              <span className="dot">Updated {relativeTime(stack.updatedAt)}</span>
            </div>
            {stack.description ? (
              <div className="stak-public-muted" style={{ marginTop: '0.4rem' }}>
                {stack.description}
              </div>
            ) : null}
          </Link>
        ))
      )}
    </PublicShell>
  );
}

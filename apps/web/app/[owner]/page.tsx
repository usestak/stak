import { notFound } from 'next/navigation';

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
    <main>
      <h1>@{profile.owner}</h1>
      {profile.displayName ? (
        <p className="muted">{profile.displayName}</p>
      ) : null}

      <h2>Public Stacks</h2>
      {profile.stacks.length === 0 ? (
        <p className="muted">No public Stacks yet.</p>
      ) : (
        profile.stacks.map((stack) => (
          <a
            key={stack.slug}
            className="card"
            href={`/@${profile.owner}/${stack.slug}`}
            style={{ display: 'block', color: 'inherit' }}
          >
            <div className="card-title">{stack.displayName}</div>
            <div className="meta">
              <span className="mono">
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
              <div className="muted" style={{ marginTop: '0.4rem' }}>
                {stack.description}
              </div>
            ) : null}
          </a>
        ))
      )}
    </main>
  );
}

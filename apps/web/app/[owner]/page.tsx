import { notFound } from 'next/navigation';

import { getCloudService } from '@/lib/cloud-service';

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
      {profile.displayName ? <p>{profile.displayName}</p> : null}
      <h2>Public Stacks</h2>
      {profile.stacks.length === 0 ? (
        <p>No public Stacks yet.</p>
      ) : (
        <ul>
          {profile.stacks.map((stack) => (
            <li key={stack.slug}>
              <a href={`/@${profile.owner}/${stack.slug}`}>
                {stack.displayName}
              </a>
              {stack.latestVersionNumber
                ? ` · v${stack.latestVersionNumber}`
                : ''}
              {stack.description ? <div>{stack.description}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

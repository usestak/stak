import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { SiteHeader } from '@/app/_components/site-header';
import { getSessionUser } from '@/lib/session';

import { RecoverClient } from './recover-client';

export const dynamic = 'force-dynamic';

const Shell = ({ children }: { children: ReactNode }) => (
  <>
    <SiteHeader />
    <div className="page">
      <main>{children}</main>
    </div>
  </>
);

export default async function MemoryRecoverPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  if (!session)
    return (
      <Shell>
        <h1>Unlock your Stack Memory</h1>
        <p className="muted">
          Start from your terminal with <code>stack memory recover</code>.
        </p>
      </Shell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/recover?session=${encodeURIComponent(session)}`;
    return (
      <Shell>
        <h1>Unlock your Stack Memory</h1>
        <p style={{ marginTop: '1.5rem' }}>
          <a
            className="btn"
            href={`/auth/login?next=${encodeURIComponent(next)}`}
          >
            Sign in with GitHub
          </a>
        </p>
      </Shell>
    );
  }

  const host = (await headers()).get('host') ?? 'localhost';
  const rpId = host.split(':')[0] ?? 'localhost';

  return (
    <Shell>
      <h1>Unlock your Stack Memory</h1>
      <p className="muted">
        Use your passkey to unlock Protected Memory for the CLI.
      </p>
      <RecoverClient sessionId={session} rpId={rpId} />
    </Shell>
  );
}

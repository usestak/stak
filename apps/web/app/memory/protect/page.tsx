import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { SiteHeader } from '@/app/_components/site-header';
import { getSessionUser } from '@/lib/session';

import { ProtectClient } from './protect-client';

export const dynamic = 'force-dynamic';

const Shell = ({ children }: { children: ReactNode }) => (
  <>
    <SiteHeader />
    <div className="page">
      <main>{children}</main>
    </div>
  </>
);

export default async function MemoryProtectPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  if (!session)
    return (
      <Shell>
        <h1>Protect your Stack Memory</h1>
        <p className="muted">
          Start from your terminal with <code>stack memory protect</code>.
        </p>
      </Shell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/protect?session=${encodeURIComponent(session)}`;
    return (
      <Shell>
        <h1>Protect your Stack Memory</h1>
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
      <h1>Protect your Stack Memory</h1>
      <p className="muted">
        Set up a passkey so only you can unlock your Memory. Protected backups
        are encrypted on your device before they reach Stack Cloud.
      </p>
      <ProtectClient
        sessionId={session}
        rpId={rpId}
        userName={user.githubUsername ?? 'stack-user'}
      />
    </Shell>
  );
}

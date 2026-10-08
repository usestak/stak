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
        <h1>Protect your STAK Memory</h1>
        <p className="lead">
          Protection starts on the machine that has your Memory — this page
          can&apos;t begin it on its own.
        </p>
        <p className="muted">Run on that machine:</p>
        <pre>
          <code>stak memory protect</code>
        </pre>
        <p className="muted">
          If you use a passkey, the CLI opens this browser with a secure session
          to finish the ceremony.
        </p>
      </Shell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/protect?session=${encodeURIComponent(session)}`;
    return (
      <Shell>
        <h1>Protect your STAK Memory</h1>
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
      <h1>Protect your STAK Memory</h1>
      <p className="muted">
        Set up a passkey so only you can unlock your Memory. Protected backups
        are encrypted on your device before they reach STAK Cloud.
      </p>
      <ProtectClient
        sessionId={session}
        rpId={rpId}
        userName={user.githubUsername ?? 'stack-user'}
      />
    </Shell>
  );
}

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
        <h1>Unlock your STAK Memory</h1>
        <p className="lead">
          Recovery starts on the machine receiving the Memory — this page
          can&apos;t begin it on its own.
        </p>
        <p className="muted">Run on that machine:</p>
        <pre>
          <code>stak memory recover</code>
        </pre>
        <p className="muted">
          If your Memory is Protected with a passkey, the CLI opens this browser
          with a secure recovery session. Restoring it into your agents&apos;
          files is a separate step —{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak memory restore</code>
          , run on that machine afterward.
        </p>
      </Shell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/recover?session=${encodeURIComponent(session)}`;
    return (
      <Shell>
        <h1>Unlock your STAK Memory</h1>
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
      <h1>Unlock your STAK Memory</h1>
      <p className="muted">
        Use your passkey to unlock Protected Memory for the CLI.
      </p>
      <RecoverClient sessionId={session} rpId={rpId} />
    </Shell>
  );
}

import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { FocusedShell } from '@/app/_components/focused-shell';
import { InlineCommand } from '@/app/_components/inline-command';
import { getSessionUser } from '@/lib/session';

import { RecoverClient } from './recover-client';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function MemoryRecoverPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  if (!session)
    return (
      <FocusedShell eyebrow="Memory · Recover" title="Unlock your STAK Memory">
        <p>
          Recovery starts on the machine receiving the Memory — this page
          can&apos;t begin it on its own.
        </p>
        <p className="stak-focus-eyebrow">Run on that machine</p>
        <pre className="stak-cmd">
          <code>stak memory recover</code>
        </pre>
        <p>
          If your Memory is Protected with a passkey, the CLI opens this browser
          with a secure recovery session. Restoring it into your agents&apos;
          files is a separate step —{' '}
          <InlineCommand command="stak memory restore" />, run on that machine
          afterward.
        </p>
      </FocusedShell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/recover?session=${encodeURIComponent(session)}`;
    return (
      <FocusedShell eyebrow="Memory · Recover" title="Unlock your STAK Memory">
        <div className="stak-focus-actions">
          <a
            className="stak-btn"
            href={`/auth/login?next=${encodeURIComponent(next)}`}
          >
            Sign in with GitHub
          </a>
        </div>
      </FocusedShell>
    );
  }

  const host = (await headers()).get('host') ?? 'localhost';
  const rpId = host.split(':')[0] ?? 'localhost';

  return (
    <FocusedShell eyebrow="Memory · Recover" title="Unlock your STAK Memory">
      <p>Use your passkey to unlock Protected Memory for the CLI.</p>
      <RecoverClient sessionId={session} rpId={rpId} />
    </FocusedShell>
  );
}

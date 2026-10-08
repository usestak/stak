import { headers } from 'next/headers';

import { FocusedShell } from '@/app/_components/focused-shell';
import { getSessionUser } from '@/lib/session';

import { ProtectClient } from './protect-client';

export const dynamic = 'force-dynamic';

export default async function MemoryProtectPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  if (!session)
    return (
      <FocusedShell eyebrow="Memory · Protect" title="Protect your STAK Memory">
        <p>
          Protection starts on the machine that has your Memory — this page
          can&apos;t begin it on its own.
        </p>
        <p className="stak-focus-eyebrow">Run on that machine</p>
        <pre className="stak-cmd">
          <code>stak memory protect</code>
        </pre>
        <p>
          If you use a passkey, the CLI opens this browser with a secure session
          to finish the ceremony.
        </p>
      </FocusedShell>
    );

  const user = await getSessionUser();
  if (!user) {
    const next = `/memory/protect?session=${encodeURIComponent(session)}`;
    return (
      <FocusedShell eyebrow="Memory · Protect" title="Protect your STAK Memory">
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
    <FocusedShell eyebrow="Memory · Protect" title="Protect your STAK Memory">
      <p>
        Set up a passkey so only you can unlock your Memory. Protected backups
        are encrypted on your device before they reach STAK Cloud.
      </p>
      <ProtectClient
        sessionId={session}
        rpId={rpId}
        userName={user.githubUsername ?? 'stack-user'}
      />
    </FocusedShell>
  );
}

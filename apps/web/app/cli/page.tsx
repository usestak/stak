import type { Metadata } from 'next';

import { FocusedShell } from '@/app/_components/focused-shell';
import { getCloudService } from '@/lib/cloud-service';
import { supabaseServerClient } from '@/lib/supabase-server';

import { AuthorizeButton } from './authorize-button';
import { loadPendingCliAuthSession } from './queries';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function CliPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  if (!code)
    return (
      <FocusedShell title="Device authorization">
        <p>
          No code provided. Start from your terminal with{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
        </p>
      </FocusedShell>
    );

  // A real, read-only peek — never mutates except the one legitimate lazy-expiry
  // transition — so unknown/expired/already-used codes render honestly before any
  // sign-in redirect or Approve click, instead of only surfacing on a failed approval.
  const session = await loadPendingCliAuthSession(getCloudService(), code);

  if (!session)
    return (
      <FocusedShell eyebrow="Verification code" title="Authorize the STAK CLI">
        <p className="stak-focus-code">{code}</p>
        <p className="stak-focus-error">
          We don&rsquo;t recognize this code. It may have been mistyped.
        </p>
        <p>
          Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
          again in your terminal for a new code.
        </p>
      </FocusedShell>
    );

  if (session.status === 'expired')
    return (
      <FocusedShell eyebrow="Verification code" title="Authorize the STAK CLI">
        <p className="stak-focus-code">{code}</p>
        <p className="stak-focus-error">This code has expired.</p>
        <p>
          Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
          again in your terminal for a new code.
        </p>
      </FocusedShell>
    );

  if (session.status !== 'pending')
    return (
      <FocusedShell eyebrow="Verification code" title="Authorize the STAK CLI">
        <p className="stak-focus-code">{code}</p>
        <p>This authorization request is no longer pending.</p>
        <p>
          If you&rsquo;re trying to sign the CLI in again, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code> for a
          new code.
        </p>
      </FocusedShell>
    );

  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/cli?code=${encodeURIComponent(code)}`;
    return (
      <FocusedShell eyebrow="Verification code" title="Authorize the STAK CLI">
        <p className="stak-focus-code">{code}</p>
        {session.label ? (
          <p>
            Device: <strong>{session.label}</strong>
          </p>
        ) : null}
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

  return (
    <FocusedShell title="Authorize the STAK CLI">
      <p>Confirm this matches the code shown in your terminal:</p>
      <p className="stak-focus-code">{code}</p>
      {session.label ? (
        <p>
          Device: <strong>{session.label}</strong>
        </p>
      ) : null}
      <AuthorizeButton userCode={code} />
    </FocusedShell>
  );
}

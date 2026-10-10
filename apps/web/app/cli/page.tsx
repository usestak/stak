import type { Metadata } from 'next';

import {
  CliApprovalCard,
  CliApprovalShell,
} from '@/app/_components/cli-approval-shell';
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
      <CliApprovalShell code={code}>
        <CliApprovalCard heading="Authorize the STAK CLI">
          <p className="stak-cli-error">
            We don&rsquo;t recognize this code. It may have been mistyped.
          </p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    );

  if (session.status === 'expired')
    return (
      <CliApprovalShell code={code}>
        <CliApprovalCard heading="Authorize the STAK CLI">
          <p className="stak-cli-error">
            This authorization code has expired.
          </p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    );

  if (session.status !== 'pending')
    return (
      <CliApprovalShell code={code}>
        <CliApprovalCard heading="Authorize the STAK CLI">
          <p className="stak-cli-sub">
            This authorization request is no longer pending.
          </p>
          <p className="stak-cli-safety">
            If you&rsquo;re trying to sign the CLI in again, run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak login</code> for
            a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    );

  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/cli?code=${encodeURIComponent(code)}`;
    return (
      <CliApprovalShell code={code} waiting>
        <CliApprovalCard
          heading="Authorize the STAK CLI"
          sub="Sign in to confirm it's you before this machine connects."
          code={code}
          label={session.label}
        >
          <div className="stak-cli-actions">
            <a
              className="stak-cli-approve"
              href={`/auth/login?next=${encodeURIComponent(next)}`}
            >
              Sign in with GitHub
            </a>
            <a className="stak-cli-decline" href="/">
              This wasn&rsquo;t me
            </a>
          </div>
          <p className="stak-cli-safety">
            Only continue if you just ran{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
            &ldquo;This wasn&rsquo;t me&rdquo; just leaves this page &mdash;
            it doesn&rsquo;t notify anyone.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    );
  }

  const metadata = (user.user_metadata ?? {}) as Record<string, string>;
  const displayName = metadata.full_name ?? metadata.name ?? metadata.user_name;

  return (
    <CliApprovalShell code={code} waiting>
      <CliApprovalCard
        heading="Approve this machine?"
        sub={
          <>
            A terminal asked to connect to{' '}
            {displayName ? <>{displayName}&rsquo;s</> : 'your'} STAK. Only
            approve if you just ran{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
          </>
        }
        code={code}
        label={session.label}
      >
        <AuthorizeButton userCode={code} />
      </CliApprovalCard>
    </CliApprovalShell>
  );
}

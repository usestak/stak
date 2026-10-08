import { FocusedShell } from '@/app/_components/focused-shell';
import { supabaseServerClient } from '@/lib/supabase-server';

import { AuthorizeButton } from './authorize-button';

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

  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/cli?code=${encodeURIComponent(code)}`;
    return (
      <FocusedShell eyebrow="Verification code" title="Authorize the STAK CLI">
        <p className="stak-focus-code">{code}</p>
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
      <AuthorizeButton userCode={code} />
    </FocusedShell>
  );
}

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
      <main>
        <h1>Device authorization</h1>
        <p className="muted">
          No code provided. Start from your terminal with{' '}
          <code>stack login</code>.
        </p>
      </main>
    );

  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/cli?code=${encodeURIComponent(code)}`;
    return (
      <main>
        <h1>Authorize the Stack CLI</h1>
        <p className="muted">Verification code</p>
        <p className="codechip">{code}</p>
        <p style={{ marginTop: '1.5rem' }}>
          <a
            className="btn"
            href={`/auth/login?next=${encodeURIComponent(next)}`}
          >
            Sign in with GitHub
          </a>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Authorize the Stack CLI</h1>
      <p className="muted">
        Confirm this matches the code shown in your terminal:
      </p>
      <p className="codechip">{code}</p>
      <div style={{ marginTop: '1.5rem' }}>
        <AuthorizeButton userCode={code} />
      </div>
    </main>
  );
}

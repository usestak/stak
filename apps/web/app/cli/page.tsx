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
        <p>
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
        <h1>Authorize Stack CLI</h1>
        <p>
          Verification code: <strong>{code}</strong>
        </p>
        <p>
          <a href={`/auth/login?next=${encodeURIComponent(next)}`}>
            Sign in with GitHub
          </a>{' '}
          to continue.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Authorize Stack CLI</h1>
      <p>Confirm this matches the code shown in your terminal:</p>
      <p>
        <strong style={{ fontSize: '1.4rem', letterSpacing: '0.15rem' }}>
          {code}
        </strong>
      </p>
      <AuthorizeButton userCode={code} />
    </main>
  );
}

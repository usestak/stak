import type { ReactNode } from 'react';

import { SiteHeader } from '@/app/_components/site-header';
import { supabaseServerClient } from '@/lib/supabase-server';

import { AuthorizeButton } from './authorize-button';

export const dynamic = 'force-dynamic';

const Shell = ({ children }: { children: ReactNode }) => (
  <>
    <SiteHeader />
    <div className="page">
      <main>{children}</main>
    </div>
  </>
);

export default async function CliPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  if (!code)
    return (
      <Shell>
        <h1>Device authorization</h1>
        <p className="muted">
          No code provided. Start from your terminal with{' '}
          <code>stak login</code>.
        </p>
      </Shell>
    );

  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/cli?code=${encodeURIComponent(code)}`;
    return (
      <Shell>
        <h1>Authorize the STAK CLI</h1>
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
      </Shell>
    );
  }

  return (
    <Shell>
      <h1>Authorize the STAK CLI</h1>
      <p className="muted">
        Confirm this matches the code shown in your terminal:
      </p>
      <p className="codechip">{code}</p>
      <div style={{ marginTop: '1.5rem' }}>
        <AuthorizeButton userCode={code} />
      </div>
    </Shell>
  );
}

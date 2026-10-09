import type { Metadata } from 'next';

import { FocusedShell } from '@/app/_components/focused-shell';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const REASONS: Record<string, { title: string; body: string }> = {
  'missing-code': {
    title: "That sign-in link didn't work",
    body: "GitHub didn't send back the information STAK needed to finish signing you in. Nothing was changed on your account.",
  },
  'exchange-failed': {
    title: "We couldn't finish signing you in",
    body: 'The sign-in attempt failed or expired before it completed. Nothing was changed on your account.',
  },
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const copy = REASONS[reason ?? ''] ?? {
    title: "We couldn't sign you in",
    body: 'Something went wrong completing sign-in. Nothing was changed on your account.',
  };

  return (
    <FocusedShell title={copy.title}>
      <p>{copy.body}</p>
      <div className="stak-focus-actions">
        <a className="stak-btn" href="/auth/login?next=/overview">
          Try signing in again
        </a>
      </div>
    </FocusedShell>
  );
}

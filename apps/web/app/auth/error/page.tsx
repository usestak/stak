import { SiteHeader } from '@/app/_components/site-header';

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
    <>
      <SiteHeader />
      <div className="page">
        <main>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.body}</p>
          <p style={{ marginTop: '1.5rem' }}>
            <a className="btn" href="/auth/login?next=/overview">
              Try signing in again
            </a>
          </p>
        </main>
      </div>
    </>
  );
}

import { redirect } from 'next/navigation';

import { SiteHeader } from './_components/site-header';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Signed-in users go through onboarding's own real-state check, which sends
  // an already-established account straight on to Overview (never trapped).
  if (await getSessionUser()) redirect('/onboarding');
  return (
    <>
      <SiteHeader />
      <div className="page">
        <main>
          <h1>STAK Cloud</h1>
          <p className="lead">
            Keep your AI agent Skills reproducible across machines. Your STAK
            lives locally and syncs privately to the Cloud.
          </p>

          <p style={{ marginTop: '1.5rem' }}>
            <a className="btn" href="/auth/login?next=/onboarding">
              Sign in with GitHub
            </a>
          </p>

          <h2>From your terminal</h2>
          <pre>
            <code>{`stak login\nstak push`}</code>
          </pre>

          <p className="muted">
            Authorizing a device? Continue to{' '}
            <a href="/cli">device authorization</a>.
          </p>
        </main>
      </div>
    </>
  );
}

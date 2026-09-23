import { redirect } from 'next/navigation';

import { SiteHeader } from './_components/site-header';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Signed-in users go straight to their product; logged-out users see marketing.
  if (await getSessionUser()) redirect('/dashboard');
  return (
    <>
      <SiteHeader />
      <div className="page">
        <main>
          <h1>Stack Cloud</h1>
          <p className="lead">
            Keep your AI agent Skills reproducible across machines. Your Stack
            lives locally and syncs privately to the Cloud.
          </p>

          <p style={{ marginTop: '1.5rem' }}>
            <a className="btn" href="/auth/login?next=/dashboard">
              Sign in with GitHub
            </a>
          </p>

          <h2>From your terminal</h2>
          <pre>
            <code>{`stack login\nstack push`}</code>
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

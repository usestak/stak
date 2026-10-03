import { redirect } from 'next/navigation';

import { SiteHeader } from '@/app/_components/site-header';
import { displayNameOf, getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/auth/login?next=/settings');

  return (
    <>
      <SiteHeader user={user} />
      <div className="page">
        <main>
          <h1>Settings</h1>

          <h2>Account</h2>
          <div className="card">
            <div className="card-title">{displayNameOf(user)}</div>
            {user.githubUsername ? (
              <div className="muted">@{user.githubUsername}</div>
            ) : null}
          </div>

          <h2>CLI</h2>
          <p className="muted">
            Sign in and out of the CLI from your terminal with{' '}
            <code>stak login</code> and <code>stak logout</code>.
          </p>

          <h2>Session</h2>
          <form method="post" action="/auth/signout">
            <button type="submit" className="btn btn-secondary">
              Sign out
            </button>
          </form>
        </main>
      </div>
    </>
  );
}

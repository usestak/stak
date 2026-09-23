import { redirect } from 'next/navigation';

import { SiteHeader } from '@/app/_components/site-header';
import { listUserStacks, type WebStackSummary } from '@/lib/dashboard';
import { relativeTime, skillCount } from '@/lib/format';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const StackRow = ({ stack }: { stack: WebStackSummary }) => (
  <a className="card card-link" href={`/dashboard/${stack.slug}`}>
    <div className="card-title">{stack.name}</div>
    <div className="meta">
      <span>{skillCount(stack.skillCount)}</span>
      {stack.cloudVersion != null ? (
        <span className="dot">Cloud version {stack.cloudVersion}</span>
      ) : (
        <span className="dot">Not pushed yet</span>
      )}
      {stack.updatedAt ? (
        <span className="dot">Updated {relativeTime(stack.updatedAt)}</span>
      ) : null}
    </div>
  </a>
);

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect('/auth/login?next=/dashboard');

  let stacks: WebStackSummary[] = [];
  let failed = false;
  try {
    stacks = await listUserStacks(user.id);
  } catch {
    failed = true;
  }

  return (
    <>
      <SiteHeader user={user} />
      <div className="page">
        <main>
          <h1>Your Stacks</h1>

          {failed ? (
            <div className="notice">
              <p>Could not load your Stacks.</p>
              <p className="muted">
                <a href="/dashboard">Try again.</a>
              </p>
            </div>
          ) : stacks.length === 0 ? (
            <div className="notice">
              <p>No Stacks in Cloud yet.</p>
              <p className="muted">Push your first Stack from your terminal:</p>
              <pre>
                <code>stack push</code>
              </pre>
            </div>
          ) : (
            stacks.map((stack) => <StackRow key={stack.slug} stack={stack} />)
          )}
        </main>
      </div>
    </>
  );
}

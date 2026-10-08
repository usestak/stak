import { redirect } from 'next/navigation';

import { FocusedShell } from './_components/focused-shell';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Signed-in users go through onboarding's own real-state check, which sends
  // an already-established account straight on to Overview (never trapped).
  if (await getSessionUser()) redirect('/onboarding');
  return (
    <FocusedShell title="STAK Cloud">
      <p>
        Keep your AI agent Skills reproducible across machines. Your STAK lives
        locally and syncs privately to the Cloud.
      </p>

      <div className="stak-focus-actions">
        <a className="stak-btn" href="/auth/login?next=/onboarding">
          Sign in with GitHub
        </a>
      </div>

      <p className="stak-focus-eyebrow">From your terminal</p>
      <pre className="stak-cmd">
        <code>{`stak login\nstak push`}</code>
      </pre>

      <p>
        Authorizing a device? Continue to{' '}
        <a href="/cli">device authorization</a>.
      </p>
    </FocusedShell>
  );
}

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AppSidebar } from '@/app/_components/app-sidebar';
import { InlineCommand } from '@/app/_components/inline-command';
import { ShellNotice } from '@/app/_components/shell-notice';
import { getCloudService } from '@/lib/cloud-service';
import { readActiveMachinePreference } from '@/lib/machine-preference';
import { loadSidebarShell } from '@/lib/sidebar-shell';
import { displayNameOf, getSessionUser } from '@/lib/session';

import { loadSettingsView } from './settings-data';
import { DeleteCloudMemory } from './delete-cloud-memory';
import './settings.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const MODE_COPY: Record<
  'standard' | 'protected',
  { title: string; body: string }
> = {
  standard: {
    title: 'Standard',
    body: "Private to your account. STAK's service can read it to deliver it.",
  },
  protected: {
    title: 'Protected',
    body: "Encrypted on your machine before it leaves. STAK stores ciphertext and can't read it.",
  },
};

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/auth/login?next=/settings');
  const handle = user.githubUsername ?? displayNameOf(user);
  const machine = await readActiveMachinePreference();
  const [view, { machineContext, sidebarCounts }] = await Promise.all([
    loadSettingsView(getCloudService(), user),
    loadSidebarShell(getCloudService(), user, machine),
  ]);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="settings"
        handle={handle}
        title="Couldn't load Settings"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your account. Reload to try again.
        </p>
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="settings"
        handle={handle}
        counts={sidebarCounts}
        viewing={machineContext.viewing}
        machines={machineContext.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <h1>Settings</h1>
          </div>
          <span className="stak-sub">
            Account-wide controls — these apply to every machine on your STAK,
            not just the one you&apos;re viewing elsewhere in the app.
          </span>
        </div>

        <div className="stak-col" style={{ borderRight: 'none', gap: 0 }}>
          <section className="stak-settings-section">
            <h2>Account</h2>
            <div className="stak-settings-row">
              <span>{displayNameOf(user)}</span>
              {user.githubUsername ? (
                <span style={{ color: 'var(--faint)' }}>
                  @{user.githubUsername}
                </span>
              ) : null}
            </div>
            <form method="post" action="/auth/signout">
              <button type="submit" className="stak-btn">
                Sign out
              </button>
            </form>
          </section>

          <section className="stak-settings-section">
            <h2>
              Memory mode <span className="unit">· account-wide</span>
            </h2>
            {view.mode ? (
              <div className="stak-settings-fact">
                <span className="state">{MODE_COPY[view.mode].title}</span>
                <span className="detail">{MODE_COPY[view.mode].body}</span>
              </div>
            ) : (
              <p className="stak-settings-p">
                Not backed up yet. Run{' '}
                <InlineCommand command="stak memory backup" /> on a machine to
                set a mode and create your first backup.
              </p>
            )}
            {view.mode === 'protected' ? (
              <p className="stak-settings-p">
                Mode is set on your machine, not in the browser. Add or change
                recovery methods below.
              </p>
            ) : view.mode === 'standard' ? (
              <p className="stak-settings-p">
                Mode is set on your machine, not in the browser. To move to
                Protected, run <InlineCommand command="stak memory protect" />{' '}
                on a machine that has your Memory — it encrypts every future
                backup there before it leaves.
              </p>
            ) : null}
          </section>

          <section className="stak-settings-section">
            <h2>Recovery</h2>
            {view.recoveryMethods.length > 0 ? (
              <div className="stak-settings-fact">
                <span className="state">Configured</span>
                <span className="detail">
                  {view.recoveryMethods.map((m) => m.label).join(', ')}
                </span>
              </div>
            ) : (
              <div className="stak-settings-fact">
                <span className="state">
                  {view.recoveryNeedsAttention ? (
                    <span className="stak-settings-attn">Needs attention</span>
                  ) : (
                    'Not configured'
                  )}
                </span>
                <span className="detail">
                  {view.recoveryNeedsAttention
                    ? 'Protected Memory has no recovery method yet.'
                    : 'Standard Memory never requires one.'}
                </span>
              </div>
            )}
            <p className="stak-settings-p">
              A Cloud backup existing doesn&apos;t mean recovery is configured —
              a separate fact. Run{' '}
              <InlineCommand command="stak memory protect --passkey" /> to add a
              passkey (it opens your browser for the passkey ceremony), or{' '}
              <InlineCommand command="stak memory protect" /> to write a
              recovery file instead — entirely on that machine, no browser step.
              To use Protected Memory on a new machine, run{' '}
              <InlineCommand command="stak memory recover" /> there.
            </p>
          </section>

          <section className="stak-settings-section">
            <h2>Machine access</h2>
            <p className="stak-settings-p">
              {view.activeMachineCount} active machine
              {view.activeMachineCount === 1 ? '' : 's'}.
            </p>
            <a className="stak-btn" href="/machines">
              Manage machines
            </a>
          </section>

          <section className="stak-settings-section">
            <h2>Delete Cloud Memory</h2>
            <p className="stak-settings-p">
              Deletes every Cloud Memory backup and revokes your recovery
              methods. Native agent Memory and local files on your machines are
              untouched.
            </p>
            <DeleteCloudMemory hasCloudMemory={view.backedUp} />
          </section>
        </div>
      </main>
    </div>
  );
}

import { redirect } from 'next/navigation';

import { AppSidebar } from '@/app/_components/app-sidebar';
import {
  PLACEHOLDER_COUNTS,
  ShellNotice,
} from '@/app/_components/shell-notice';
import { getCloudService } from '@/lib/cloud-service';
import { displayNameOf, getSessionUser } from '@/lib/session';

import { loadSettingsView } from './settings-data';
import { DeleteCloudMemory } from './delete-cloud-memory';

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
  const view = await loadSettingsView(getCloudService(), user);

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
        counts={PLACEHOLDER_COUNTS}
        viewing={null}
        machines={[]}
      />
      <main className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span style={{ fontSize: 26, fontWeight: 600 }}>Settings</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 28,
            maxWidth: 700,
            padding: '8px 32px 40px',
          }}
        >
          <section
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <h2>Account</h2>
            <div className="card">
              <div className="card-title">{displayNameOf(user)}</div>
              {user.githubUsername ? (
                <div className="muted">@{user.githubUsername}</div>
              ) : null}
            </div>
            <form method="post" action="/auth/signout">
              <button type="submit" className="btn btn-secondary">
                Sign out
              </button>
            </form>
          </section>

          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingTop: 18,
              borderTop: '1px solid #232220',
            }}
          >
            <h2 style={{ margin: 0 }}>
              Memory mode{' '}
              <span
                style={{ fontWeight: 400, color: '#a19d94', fontSize: 13.5 }}
              >
                · applies to all your Memory
              </span>
            </h2>
            {view.mode ? (
              <div
                style={{
                  padding: '14px 16px',
                  border: '1.5px solid #84cb8e',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: '#a19d94',
                  maxWidth: 420,
                }}
              >
                <div
                  style={{
                    fontSize: 14.5,
                    fontWeight: 600,
                    color: '#edeae3',
                    marginBottom: 4,
                  }}
                >
                  {MODE_COPY[view.mode].title}
                </div>
                {MODE_COPY[view.mode].body}
              </div>
            ) : (
              <p className="muted">
                Not backed up yet. Run <code>stak memory backup</code> on a
                machine to set a mode and create your first backup.
              </p>
            )}
            <span style={{ fontSize: 12.5, color: '#85817a' }}>
              Switching to Protected encrypts every backup on your machine
              first. Run{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>
                stak memory protect
              </code>{' '}
              on a machine that has your Memory — it can&apos;t be switched from
              the browser, because the encryption happens on your machine.
            </span>
          </section>

          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingTop: 18,
              borderTop: '1px solid #232220',
            }}
          >
            <h2 style={{ margin: 0 }}>Recovery</h2>
            <p className="muted" style={{ margin: 0 }}>
              You need one of these to open Protected Memory on a new machine.
              STAK can&apos;t reset them for you.
            </p>
            {view.recoveryNeedsAttention ? (
              <p
                role="status"
                style={{ fontSize: 13, color: '#e5b85c', margin: 0 }}
              >
                Needs attention — Protected Memory has no recovery method yet.
              </p>
            ) : null}
            {view.recoveryMethods.length > 0 ? (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {view.recoveryMethods.map((m, index) => (
                  <li
                    key={`${m.type}-${index}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      border: '1px solid #232220',
                      borderRadius: 6,
                      fontSize: 13.5,
                    }}
                  >
                    <span>{m.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Not configured.
              </p>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <a className="btn btn-secondary" href="/memory/protect">
                Add a passkey
              </a>
              <a className="btn btn-secondary" href="/memory/recover">
                Use recovery file
              </a>
            </div>
          </section>

          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingTop: 18,
              borderTop: '1px solid #232220',
            }}
          >
            <h2 style={{ margin: 0 }}>Machine access</h2>
            <p className="muted" style={{ margin: 0 }}>
              {view.activeMachineCount} active machine
              {view.activeMachineCount === 1 ? '' : 's'}.
            </p>
            <a
              className="btn btn-secondary"
              style={{ alignSelf: 'flex-start' }}
              href="/machines"
            >
              Manage machines
            </a>
          </section>

          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingTop: 18,
              borderTop: '1px solid #232220',
            }}
          >
            <h2 style={{ margin: 0 }}>Delete cloud Memory</h2>
            <p className="muted" style={{ margin: 0 }}>
              Permanently removes every Memory backup STAK holds. Files on your
              machines aren&apos;t touched. This is not archiving: archiving a
              project never deletes anything.
            </p>
            <DeleteCloudMemory />
          </section>
        </div>
      </main>
    </div>
  );
}

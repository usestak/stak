import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { loadStacksView } from './stacks-data';
import { StackCard } from './_components/stack-card';
import './stacks.css';

export const dynamic = 'force-dynamic';

export default async function StacksPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadStacksView(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="stacks"
        handle={handle}
        title="Couldn't load your Stacks"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="stacks" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="stacks" handle={handle} title="Choose a machine">
        <p>Pick the machine you want this sidebar to follow.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/stacks" />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="stacks"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <h1>{view.statusSentence}</h1>
          </div>
          <span className="stak-sub">
            A Stack is the Skills that make up your portable STAK environment.
            Any machine can bring it down with{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak pull</code>.
          </span>
        </div>
        <div
          style={{
            padding: '22px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          {view.owned ? (
            <StackCard stack={view.owned} />
          ) : (
            <div className="stak-stacks-empty-state">
              <h2>No Stack yet</h2>
              <p>
                Your Stack is created the first time you approve a Skill or run
                a Memory backup. There&apos;s nothing to compose yet.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

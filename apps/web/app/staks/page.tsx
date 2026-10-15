import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { InlineCommand } from '../_components/inline-command';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { readActiveMachinePreference } from '../../lib/machine-preference';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { loadStacksView } from './staks-data';
import { StakCard } from './_components/stak-card';
import { SavedStaksSection } from './_components/saved-staks-section';
import './staks.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function StaksPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine: requestedMachine } = await searchParams;
  const machine = requestedMachine ?? (await readActiveMachinePreference());
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadStacksView(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="staks"
        handle={handle}
        title="Couldn't load your STAKs"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="staks" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <InlineCommand command="stak login" />, then{' '}
          <InlineCommand command="stak scan" />.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="staks" handle={handle} title="Choose a machine">
        <p>Pick the machine you want this sidebar to follow.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <InlineCommand command="stak status" /> on the machine you want,
            then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/staks" />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="staks"
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
            A STAK is the Skills that make up your portable environment. Any
            machine can bring it down with <InlineCommand command="stak pull" />
            .
          </span>
        </div>
        <div
          style={{
            padding: '22px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 32,
          }}
        >
          <section
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              Main STAK
            </h2>
            <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
              Your always-active desired environment — what every machine
              reconciles to.
            </span>
            {view.owned ? (
              <StakCard stack={view.owned} />
            ) : (
              <div className="stak-stacks-empty-state">
                <h2>No STAK yet</h2>
                <p>
                  Your STAK is created the first time you approve a Skill or run
                  a Memory backup. There&apos;s nothing to compose yet.
                </p>
              </div>
            )}
          </section>

          <section>
            <div className="stak-saved-stacks-head">
              <div>
                <h2>Saved STAKs</h2>
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                  Named, private compositions of your approved Skills — separate
                  from Main. Editing one never changes Main.
                </span>
              </div>
              <Link
                href="/staks/new"
                className="stak-pill"
                style={{ cursor: 'pointer' }}
              >
                New STAK
              </Link>
            </div>
            <SavedStaksSection stacks={view.savedStacks} />
          </section>
        </div>
      </main>
    </div>
  );
}

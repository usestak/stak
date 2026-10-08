import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { CommandDock } from '../_components/command-dock';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { NEW_MACHINE_STEPS, loadMachinesView } from './machines-data';
import { MachineCards } from './_components/machine-cards';
import './machines.css';

export const dynamic = 'force-dynamic';

export default async function MachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadMachinesView(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="machines"
        handle={handle}
        title="Couldn't load your Machines"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="machines" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="machines" handle={handle} title="Choose a machine">
        <p>Pick the machine you want this sidebar to follow.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/machines" />
      </ShellNotice>
    );

  const dock = view.updatesWaitingCards[0];

  return (
    <div className="stak-frame">
      <AppSidebar
        active="machines"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span>{view.statusSentence}</span>
          </div>
          <span className="stak-sub">
            Each machine reports its state when you run STAK on it. This page
            reflects its last check-in.
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
          <MachineCards cards={view.cards} />

          {view.updatesWaitingCards.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Waiting on a CLI run
              </span>
              <div className="stak-updates-waiting-list">
                {view.updatesWaitingCards.map((c) => (
                  <div key={c.machineId} className="stak-updates-waiting-row">
                    <span style={{ fontFamily: 'var(--mono)' }}>{c.name}</span>
                    <span style={{ color: 'var(--faint)' }}>
                      {c.skillsLabel}
                    </span>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                STAK can&apos;t change a machine from here. Review the exact
                updates on Skills; each installs on its machine&apos;s next CLI
                run.
              </span>
            </div>
          ) : null}

          <div className="stak-new-machine">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Bring your STAK to a new machine
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                Install the CLI there first
              </span>
            </div>
            <div className="stak-new-machine-steps">
              {NEW_MACHINE_STEPS.map((step, i) => (
                <div key={step.title} className="stak-new-machine-step">
                  {step.copyable ? (
                    <span className="cmd">
                      <span className="p">{i + 1} </span>
                      {step.syntax}
                    </span>
                  ) : (
                    <>
                      <span className="step-title">
                        {i + 1} {step.title}
                      </span>
                      <span className="syntax-ref">{step.syntax}</span>
                    </>
                  )}
                  <span className="hint">{step.hint}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {dock ? (
          <CommandDock
            machineName={dock.name}
            command="stak skill update"
            hint="Installs the approved versions this machine is waiting on."
          />
        ) : (
          <CommandDock
            machineName={view.viewing.name}
            command="stak status"
            hint="Checks in and refreshes this machine's facts."
          />
        )}
      </main>
    </div>
  );
}

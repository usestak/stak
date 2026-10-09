import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { loadMemoryView } from '../memory-data';
import './memory.css';

export const dynamic = 'force-dynamic';

const DOT: Record<'ready' | 'attention' | 'neutral', string> = {
  ready: '#84cb8e',
  attention: '#ee7a3b',
  neutral: '#a19d94',
};

const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadMemoryView(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="memory" handle={handle} title="Couldn't load Memory">
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="memory" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="memory" handle={handle} title="Choose a machine">
        <p>
          Memory shows this machine&apos;s own backup state alongside your
          account&apos;s Cloud backup. Pick the machine you want to view.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/memory" />
      </ShellNotice>
    );

  const statusDot: 'ready' | 'attention' | 'neutral' = !view.backedUp
    ? 'neutral'
    : view.machineGap || view.needsRecoveryMethod
      ? 'attention'
      : 'ready';

  return (
    <div className="stak-frame">
      <AppSidebar
        active="memory"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span
              className="stak-dot"
              style={{ width: 10, height: 10, background: DOT[statusDot] }}
              aria-hidden
            />
            <h1>{view.statusSentence}</h1>
          </div>
          <span className="stak-sub">{view.machineSentence}</span>
        </div>

        <div className="stak-summaries">
          <div className="stak-sum">
            <span className="k">MODE</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.mode === 'protected'
                ? 'Protected'
                : view.mode === 'standard'
                  ? 'Standard'
                  : 'Not set'}
            </span>
            <span className="d">{view.modeSentence}</span>
          </div>
          <div className="stak-sum">
            <span className="k">RECOVERY</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.hasRecoveryMethod ? 'Configured' : 'Not configured'}
            </span>
            <span className="d">
              {view.needsRecoveryMethod
                ? 'Needs attention — add a passkey or recovery file.'
                : view.mode === 'protected'
                  ? 'A passkey or recovery file unlocks your backups.'
                  : ' '}
            </span>
          </div>
          <div className="stak-sum">
            <span className="k">ON {view.viewing.name.toUpperCase()}</span>
            <span className="v" style={{ fontSize: 15 }}>
              {!view.viewingCheckedIn
                ? "Hasn't checked in"
                : view.machineGap
                  ? 'Changes not backed up'
                  : 'Up to date'}
            </span>
            <span className="d">{view.viewing.statusLabel}</span>
          </div>
          <div className="stak-sum">
            <span className="k">LATEST BACKUP</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.backedUp ? view.history[0]!.when : 'None yet'}
            </span>
            <span className="d">
              {view.backedUp ? dateOnly(view.history[0]!.createdAt) : ' '}
            </span>
          </div>
        </div>

        <div className="stak-body">
          <div className="stak-col">
            <section className="stak-mem-section">
              <h2>Backup history</h2>
              {view.history.length === 0 ? (
                <p className="stak-mem-empty">No backups yet.</p>
              ) : (
                <ul className="stak-mem-history">
                  {view.history.map((h) => (
                    <li key={h.generation}>
                      <span className="when">{h.when}</span>
                      <span className="mode">
                        {h.mode === 'protected' ? 'Protected' : 'Standard'}
                      </span>
                      <span className="meta">
                        {h.isLatest
                          ? `Latest backup · ${dateOnly(h.createdAt)}`
                          : dateOnly(h.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {view.mode === 'standard' ? (
              <section className="stak-mem-section">
                <h2>Projects in this backup</h2>
                {view.perProject === null || view.perProject.length === 0 ? (
                  <p className="stak-mem-empty">
                    No per-project detail is available for this backup.
                  </p>
                ) : (
                  <>
                    <p className="stak-mem-caption">
                      As of your latest Standard backup
                      {view.backedUp ? ` (${view.history[0]!.when})` : ''}.
                    </p>
                    <ul className="stak-mem-projects">
                      {view.perProject.map((p) => (
                        <li key={p.projectId}>
                          <span className="name">{p.name}</span>
                          <span className="count">
                            {p.fileCount} file{p.fileCount === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            ) : view.mode === 'protected' ? (
              <section className="stak-mem-section">
                <h2>Projects</h2>
                <p className="stak-mem-protected">
                  {view.protectedProjectsKnownCount === 0
                    ? 'No Projects are currently registered with STAK.'
                    : `${view.protectedProjectsKnownCount} project${view.protectedProjectsKnownCount === 1 ? '' : 's'} registered with STAK.`}
                </p>
                <p className="stak-mem-protected">
                  Protected backups are encrypted before they leave this
                  machine, so STAK can&apos;t compute per-project file counts
                  from their contents.
                </p>
              </section>
            ) : null}
          </div>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={view.dockCommand}
          hint={view.dockHint}
        />
      </main>
    </div>
  );
}

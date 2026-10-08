import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { CommandDock } from '../_components/command-dock';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { loadProjectsList } from './projects-data';
import { ProjectsTable } from './_components/projects-table';
import './projects.css';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadProjectsList(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="projects"
        handle={handle}
        title="Couldn't load your Projects"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="projects" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="projects" handle={handle} title="Choose a machine">
        <p>
          Projects shows presence from that machine&apos;s last check-in. Pick
          the machine you want to view.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/projects" />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="projects"
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
        </div>
        <ProjectsTable rows={view.rows} machineName={view.viewing.name} />
        <CommandDock
          machineName={view.viewing.name}
          command="stak project map <project> <directory>"
          hint="Binds a Project to a local folder on this machine. Local only — never sent to STAK Cloud."
        />
      </main>
    </div>
  );
}

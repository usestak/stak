import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { InlineCommand } from '../../_components/inline-command';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { readActiveMachinePreference } from '../../../lib/machine-preference';
import { displayNameOf, getSessionUser } from '../../../lib/session';
import { loadSidebarSummary } from '../../../lib/sidebar-summary';

import { loadProjectDetail } from './project-detail-data';
import { ProjectLifecycleButton } from '../_components/project-lifecycle-button';
import '../projects.css';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { projectId } = await params;
  const { machine: requestedMachine } = await searchParams;
  const machine = requestedMachine ?? (await readActiveMachinePreference());
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadProjectDetail(
    getCloudService(),
    user,
    projectId,
    machine,
  );

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="projects"
        handle={handle}
        title="Couldn't load this Project"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'not-found')
    return (
      <ShellNotice active="projects" handle={handle} title="Project not found">
        <p>This Project doesn&apos;t exist, or isn&apos;t in your account.</p>
        <p>
          <Link href="/projects">Back to Projects</Link>
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="projects" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <InlineCommand command="stak login" />, then{' '}
          <InlineCommand command="stak scan" />.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="projects" handle={handle} title="Choose a machine">
        <p>
          This Project&apos;s presence is shown relative to one machine. Pick
          the machine you want to view.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <InlineCommand command="stak status" /> on the machine you want,
            then pick it here.
          </p>
        ) : null}
        <MachineChooser
          options={view.machines}
          basePath={`/projects/${projectId}`}
        />
      </ShellNotice>
    );

  const sidebarCounts = await loadSidebarSummary(
    getCloudService(),
    user,
    view.viewing.machineId,
    view.machines.length,
  );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="projects"
        handle={handle}
        counts={sidebarCounts}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <Link href="/projects" style={{ color: 'inherit' }}>
              Projects
            </Link>{' '}
            / {view.name}
          </span>
          <div className="stak-sentence">
            <h1>{view.name}</h1>
          </div>
          <span className="stak-sub">{view.lifecycleLabel}</span>
        </div>

        <div className="stak-summaries">
          <div className="stak-sum">
            <span className="k">LIFECYCLE</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.lifecycleLabel}
            </span>
            <span className="d">
              Archive is organizational only — Memory is preserved.
            </span>
          </div>
          <div className="stak-sum">
            <span className="k">ON {view.viewing.name.toUpperCase()}</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.presence}
            </span>
            <span className="d">{view.viewing.statusLabel}</span>
          </div>
          <div className="stak-sum">
            <span className="k">MEMORY</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.memoryFact}
            </span>
            <span className="d"> </span>
          </div>
        </div>

        <div className="stak-body">
          <div className="stak-col">
            <section className="stak-project-section">
              <h2>Mapping</h2>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  maxWidth: 560,
                  lineHeight: 1.6,
                }}
              >
                Mapping a Project to a local folder happens only on the machine
                itself — STAK Cloud never stores or chooses a folder path. If{' '}
                {view.viewing.name} already resolves this Project automatically
                through its Git remote, no mapping command is needed there.
              </p>
            </section>

            <section className="stak-project-section">
              <h2>Actions</h2>
              <ProjectLifecycleButton
                projectId={view.technical.projectId}
                lifecycle={view.lifecycle}
              />
            </section>

            <details style={{ fontSize: 12.5 }}>
              <summary
                style={{
                  cursor: 'pointer',
                  color: 'var(--faint)',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                Technical details
              </summary>
              <div
                style={{
                  marginTop: 10,
                  font: '11.5px var(--mono)',
                  color: 'var(--faint)',
                }}
              >
                <span>projectId: {view.technical.projectId}</span>
              </div>
            </details>
          </div>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={`stak project map ${view.cliSelector} <directory>`}
          hint="Template — replace <directory> with this Project's real folder on this machine before running. Local only — never sent to STAK Cloud."
          kind="template"
        />
      </main>
    </div>
  );
}

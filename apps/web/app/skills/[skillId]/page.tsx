import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { loadSkillDetail } from '../skill-detail-data';
import { SkillActions } from '../_components/skill-actions';
import '../../overview/shell.css';
import '../skills.css';

export const dynamic = 'force-dynamic';

const PLACEHOLDER_SIDEBAR = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  stacks: '',
};

export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ skillId: string }>;
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { skillId } = await params;
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadSkillDetail(getCloudService(), user, skillId, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="skills" handle={handle} title="Couldn't load this Skill">
        <p>STAK Cloud didn&apos;t respond. This is a temporary problem, not a change to your data. Reload to try again.</p>
      </ShellNotice>
    );
  if (view.kind === 'not-found')
    return (
      <ShellNotice active="skills" handle={handle} title="Skill not found">
        <p>This Skill doesn&apos;t exist, or isn&apos;t in your account.</p>
        <p>
          <Link href="/skills">Back to Skills</Link>
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="skills" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="skills" handle={handle} title="Choose a machine">
        <p>This Skill&apos;s installed state is shown from that machine&apos;s last check-in. Pick the machine you want to view.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath={`/skills/${skillId}`} />
      </ShellNotice>
    );

  const updateAvailable = view.sourceCheckState === 'update-available';
  const dockHint = updateAvailable
    ? view.exceedsReviewBounds
      ? 'This update exceeds browser review limits; run after approving locally.'
      : 'Approve the update above, then run this on this machine to install it.'
    : 'Installs the approved version of this Skill on this machine.';

  return (
    <div className="stak-frame">
      <AppSidebar
        active="skills"
        handle={handle}
        counts={PLACEHOLDER_SIDEBAR}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span
              className="stak-dot"
              style={{ width: 10, height: 10, background: '#a19d94' }}
              aria-hidden
            />
            <span>
              <Link href="/skills" style={{ color: 'inherit' }}>
                Skills
              </Link>{' '}
              / {view.name}
            </span>
          </div>
          <span className="stak-sub">{view.statusText}</span>
        </div>

        <section style={{ padding: '0 28px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{view.name}</span>
              {view.description ? (
                <span style={{ fontSize: 13, color: 'var(--faint)' }}>{view.description}</span>
              ) : null}
              <span style={{ fontSize: 12.5, font: '12.5px var(--mono)', color: 'var(--faint)' }}>
                Source: {view.sourceLabel}
                {view.trackedRef ? ` (${view.trackedRef})` : ''}
                {view.sourceCheckNote ? <span style={{ color: 'var(--dim)' }}> · {view.sourceCheckNote}</span> : null}
              </span>
              <span style={{ fontSize: 12.5, font: '12.5px var(--mono)', color: 'var(--faint)' }}>
                Approved: {view.approvedVersionShort} · Installed here: {view.installedHere}
              </span>
              {view.checkedAt ? (
                <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                  Last checked: {new Date(view.checkedAt).toLocaleString()}
                </span>
              ) : null}
            </div>
            <SkillActions
              skillId={view.skillId}
              paused={view.paused}
              updateAvailable={updateAvailable}
              reviewArtifactId={view.reviewArtifactId}
              approvedVersionShort={view.approvedVersionShort}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--faint)' }}>CAPABILITIES</span>
            <span style={{ fontSize: 13 }}>{view.capabilitiesText}</span>
            {view.capabilityList.length > 0 ? (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {view.capabilityList.map((c) => (
                  <li key={c.label} style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                    {c.label}: {c.value === 'declared-true' ? 'Yes' : 'No'}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {updateAvailable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--faint)' }}>UPDATE REVIEW</span>
              {view.exceedsReviewBounds ? (
                <p style={{ fontSize: 13, color: 'var(--dim)' }}>
                  This update exceeds STAK&apos;s V0 review limits and can&apos;t be reviewed here. Approve
                  isn&apos;t available for this update from the browser.
                </p>
              ) : view.reviewArtifact ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {view.reviewArtifact.files.map((f) => (
                    <div
                      key={f.relativePath}
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: 6,
                        padding: 12,
                        background: '#111110',
                      }}
                    >
                      <div style={{ font: '12.5px var(--mono)', color: 'var(--faint)', marginBottom: 8 }}>
                        {f.relativePath} ({f.kind})
                      </div>
                      {f.binary ? (
                        <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                          {f.relativePath} changed (binary file)
                          {f.beforeSize !== undefined ? ` · before ${f.beforeSize} bytes` : ''}
                          {f.afterSize !== undefined ? ` · after ${f.afterSize} bytes` : ''}
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <pre
                            style={{
                              margin: 0,
                              fontSize: 11.5,
                              font: '11.5px var(--mono)',
                              color: 'var(--faint)',
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'break-word',
                            }}
                          >
                            {f.beforeText ?? '(no previous content)'}
                          </pre>
                          <pre
                            style={{
                              margin: 0,
                              fontSize: 11.5,
                              font: '11.5px var(--mono)',
                              color: 'var(--ink)',
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'break-word',
                            }}
                          >
                            {f.afterText ?? '(file removed)'}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--faint)' }}>HISTORY</span>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {view.history.map((h) => (
                <li key={h.contentHash} style={{ fontSize: 12.5, font: '12.5px var(--mono)', color: 'var(--faint)' }}>
                  {h.shortHash} · v{h.environmentVersionNumber} · {new Date(h.approvedAt).toLocaleString()}
                  {h.current ? ' · current' : ''}
                </li>
              ))}
            </ul>
          </div>
        </section>
        <CommandDock
          machineName={view.viewing.name}
          command={`stak skill update ${view.skillId}`}
          hint={dockHint}
        />
      </main>
    </div>
  );
}

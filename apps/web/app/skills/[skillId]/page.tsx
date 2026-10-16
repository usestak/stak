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
import { relative } from '../../../lib/machine-context';
import { loadSidebarSummary } from '../../../lib/sidebar-summary';

import { loadSkillDetail, type SkillDetailView } from '../skill-detail-data';
import { SkillActions } from '../_components/skill-actions';
import { SkillShareSection } from '../_components/skill-share-section';
import '../skills.css';

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

/** UPDATE CHECK fact-strip cell (§11): a plain word for the state, plus a secondary line of
 *  real context — never a fabricated "live" claim beyond what `checkedAt` actually says. */
const updateCheckFact = (
  view: Extract<SkillDetailView, { kind: 'ready' }>,
): { value: string; detail?: string } => {
  switch (view.sourceCheckState) {
    case 'cannot-check':
      return { value: "Can't check", detail: view.sourcePrimary };
    case 'not-checked':
      return { value: 'Not checked yet', detail: 'No check has been run yet.' };
    case 'check-failed':
      return {
        value: 'Check failed',
        detail: view.checkedAt
          ? `Last tried ${relative(view.checkedAt)}`
          : undefined,
      };
    case 'update-available':
      return {
        value: 'Update available',
        detail: view.checkedAt
          ? `Checked ${relative(view.checkedAt)}`
          : undefined,
      };
    default:
      return {
        value: 'No update found',
        detail: view.checkedAt
          ? `Checked ${relative(view.checkedAt)}`
          : undefined,
      };
  }
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
  const { machine: requestedMachine } = await searchParams;
  const machine = requestedMachine ?? (await readActiveMachinePreference());
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadSkillDetail(getCloudService(), user, skillId, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="skills"
        handle={handle}
        title="Couldn't load this Skill"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
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
          <InlineCommand command="stak login" />, then{' '}
          <InlineCommand command="stak scan" />.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="skills" handle={handle} title="Choose a machine">
        <p>
          This Skill&apos;s installed state is shown from that machine&apos;s
          last check-in. Pick the machine you want to view.
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
          basePath={`/skills/${skillId}`}
        />
      </ShellNotice>
    );

  const updateCheck = updateCheckFact(view);
  const dockCommand =
    view.commandDockKind === 'check'
      ? `stak skill check ${view.cliSelector}`
      : `stak skill update ${view.cliSelector}`;
  const dockHint =
    view.commandDockKind === 'check'
      ? 'No update check has been run for this source yet.'
      : view.exceedsReviewBounds
        ? 'This update exceeds browser review limits; run after approving locally.'
        : view.sourceCheckState === 'update-available'
          ? 'Approve the update above, then run this on this machine to install it.'
          : 'Reconciles this machine to the approved version.';
  const sidebarCounts = await loadSidebarSummary(
    getCloudService(),
    user,
    view.viewing.machineId,
    view.machines.length,
  );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="skills"
        handle={handle}
        counts={sidebarCounts}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <Link href="/skills" style={{ color: 'inherit' }}>
              Skills
            </Link>{' '}
            / {view.name}
          </span>
          <div className="stak-sentence">
            <span
              className="stak-dot"
              style={{ width: 10, height: 10, background: DOT[view.statusDot] }}
              aria-hidden
            />
            <h1>{view.name}</h1>
          </div>
          <span className="stak-sub">{view.statusText}</span>
        </div>

        <div className="stak-summaries">
          <div className="stak-sum">
            <span className="k">SOURCE</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.sourcePrimary}
            </span>
            <span className="d">{view.sourceSecondary ?? ' '}</span>
          </div>
          <div className="stak-sum">
            <span className="k">APPROVED IN STAK</span>
            <span className="v" style={{ fontSize: 15 }}>
              Version {view.approvedVersionOrdinal}
            </span>
            <span className="d">
              {view.approvedAt ? `Approved ${dateOnly(view.approvedAt)}` : ' '}
            </span>
          </div>
          <div className="stak-sum">
            <span className="k">ON {view.viewing.name.toUpperCase()}</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.reconciliationLabel}
            </span>
            <span className="d">
              {view.installedHereAt
                ? `Last checked in ${relative(view.installedHereAt)}`
                : "Hasn't checked in yet"}
            </span>
          </div>
          <div className="stak-sum">
            <span className="k">UPDATE CHECK</span>
            <span className="v" style={{ fontSize: 15 }}>
              {updateCheck.value}
            </span>
            <span className="d">{updateCheck.detail ?? ' '}</span>
          </div>
        </div>

        <div className="stak-body">
          <div className="stak-col">
            {view.description ? (
              <section
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <h2>About</h2>
                <p
                  style={{
                    margin: 0,
                    maxWidth: 640,
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    color: 'var(--muted)',
                  }}
                >
                  {view.description}
                </p>
              </section>
            ) : null}

            {view.sourceCheckState === 'update-available' ? (
              <section
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <h2>Changes</h2>
                {view.exceedsReviewBounds ? (
                  <p style={{ fontSize: 13, color: 'var(--faint)', margin: 0 }}>
                    This update exceeds STAK&apos;s V0 review limits and
                    can&apos;t be reviewed here. Approve isn&apos;t available
                    for this update from the browser.
                  </p>
                ) : view.reviewArtifact ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
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
                        <div
                          style={{
                            font: '12.5px var(--mono)',
                            color: 'var(--faint)',
                            marginBottom: 8,
                          }}
                        >
                          {f.relativePath} ({f.kind})
                        </div>
                        {f.binary ? (
                          <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                            {f.relativePath} changed (binary file)
                            {f.beforeSize !== undefined
                              ? ` · before ${f.beforeSize} bytes`
                              : ''}
                            {f.afterSize !== undefined
                              ? ` · after ${f.afterSize} bytes`
                              : ''}
                          </div>
                        ) : (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr 1fr',
                              gap: 10,
                            }}
                          >
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
              </section>
            ) : null}

            <section
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <h2>Version history</h2>
              {view.history.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--dim)', margin: 0 }}>
                  Only one version so far.
                </p>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {view.history.map((h) => (
                    <li
                      key={h.contentHash}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        padding: '6px 0',
                        borderBottom: '1px solid #1c1b19',
                        fontSize: 13,
                      }}
                    >
                      <span>
                        Version {h.environmentVersionNumber}
                        {h.current ? (
                          <span style={{ color: 'var(--faint)' }}>
                            {' '}
                            · Current approved version
                          </span>
                        ) : null}
                        <span
                          style={{
                            display: 'block',
                            fontSize: 12,
                            color: 'var(--dim)',
                          }}
                        >
                          Approved {dateOnly(h.approvedAt)}
                        </span>
                      </span>
                      <span
                        style={{
                          font: '11.5px var(--mono)',
                          color: 'var(--dim)',
                        }}
                      >
                        {h.shortHash}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  font: '11.5px var(--mono)',
                  color: 'var(--faint)',
                }}
              >
                <span>entryId: {view.technical.entryId}</span>
                <span>
                  approvedContentHash: {view.technical.approvedContentHash}
                </span>
                <span>
                  installedContentHash:{' '}
                  {view.technical.installedContentHash ?? '(not installed)'}
                </span>
                {view.technical.candidateRevision ? (
                  <span>
                    candidateRevision: {view.technical.candidateRevision}
                  </span>
                ) : null}
                {view.technical.trackedRef ? (
                  <span>trackedRef: {view.technical.trackedRef}</span>
                ) : null}
              </div>
            </details>
          </div>

          <div className="stak-rail">
            <section
              style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
            >
              <h2>Declared capabilities</h2>
              <span style={{ fontSize: 13 }}>{view.capabilitiesText}</span>
              {view.capabilityList.length > 0 ? (
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {view.capabilityList.map((c) => (
                    <li
                      key={c.label}
                      style={{ fontSize: 12.5, color: 'var(--faint)' }}
                    >
                      {c.label}: {c.value === 'declared-true' ? 'Yes' : 'No'}
                    </li>
                  ))}
                </ul>
              ) : (
                <span
                  style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 }}
                >
                  This Skill doesn&apos;t provide capability metadata. STAK
                  doesn&apos;t guess from its instructions.
                </span>
              )}
            </section>

            <SkillShareSection skillId={view.skillId} share={view.share} />

            <section
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <h2>Actions</h2>
              <SkillActions
                skillId={view.skillId}
                paused={view.paused}
                updateAvailable={view.sourceCheckState === 'update-available'}
                reviewArtifactId={view.reviewArtifactId}
                approvedVersionShort={view.approvedVersionShort}
              />
            </section>
          </div>
        </div>

        {view.commandDockVisible ? (
          <CommandDock
            machineName={view.viewing.name}
            command={dockCommand}
            hint={dockHint}
          />
        ) : null}
      </main>
    </div>
  );
}

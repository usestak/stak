import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { readActiveMachinePreference } from '../../../lib/machine-preference';
import { resolveSidebarMachineContext } from '../../../lib/sidebar-machine-context';
import { loadSidebarSummary } from '../../../lib/sidebar-summary';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { listApprovedSkillsForPickerAction } from '../actions';
import { NewStakForm } from '../_components/new-stak-form';
import '../staks.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewStakPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine: requestedMachine } = await searchParams;
  const machine = requestedMachine ?? (await readActiveMachinePreference());
  const handle = user.githubUsername ?? displayNameOf(user);
  const machineContext = await resolveSidebarMachineContext(
    getCloudService(),
    user.id,
    machine,
  );
  const sidebarCounts = await loadSidebarSummary(
    getCloudService(),
    user,
    machineContext.viewing?.machineId ?? null,
    machineContext.activeCount,
  );

  const skills = await listApprovedSkillsForPickerAction();
  if (!skills.ok)
    return (
      <ShellNotice active="staks" handle={handle} title="Couldn't load Skills">
        <p>{skills.error}</p>
      </ShellNotice>
    );

  if (skills.skills.length === 0)
    return (
      <ShellNotice
        active="staks"
        handle={handle}
        title="No approved Skills yet"
      >
        <p>
          A STAK can only be built from Skills you&apos;ve already approved into
          Main. Approve at least one Skill first, then come back here.
        </p>
        <p>
          <Link href="/staks">Back to STAKs</Link>
        </p>
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="staks"
        handle={handle}
        counts={sidebarCounts}
        viewing={machineContext.viewing}
        machines={machineContext.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <Link href="/staks" style={{ color: 'inherit' }}>
              STAKs
            </Link>{' '}
            / New
          </span>
          <div className="stak-sentence">
            <h1>New STAK</h1>
          </div>
          <span className="stak-sub">
            A named, private composition of your approved Skills. It won&apos;t
            affect Main.
          </span>
        </div>
        <div style={{ padding: '22px 32px' }}>
          <NewStakForm approvedSkills={skills.skills} />
        </div>
      </main>
    </div>
  );
}

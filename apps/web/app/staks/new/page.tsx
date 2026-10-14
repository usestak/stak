import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { ShellNotice } from '../../_components/shell-notice';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { listApprovedSkillsForPickerAction } from '../actions';
import { NewStakForm } from '../_components/new-stak-form';
import '../staks.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const PLACEHOLDER_SIDEBAR = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  staks: '',
};

export default async function NewStakPage() {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const handle = user.githubUsername ?? displayNameOf(user);

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
        counts={PLACEHOLDER_SIDEBAR}
        viewing={null}
        machines={[]}
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

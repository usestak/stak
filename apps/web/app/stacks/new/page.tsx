import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { ShellNotice } from '../../_components/shell-notice';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { listApprovedSkillsForPickerAction } from '../actions';
import { NewStackForm } from '../_components/new-stack-form';
import '../stacks.css';

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
  stacks: '',
};

export default async function NewStackPage() {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const handle = user.githubUsername ?? displayNameOf(user);

  const skills = await listApprovedSkillsForPickerAction();
  if (!skills.ok)
    return (
      <ShellNotice active="stacks" handle={handle} title="Couldn't load Skills">
        <p>{skills.error}</p>
      </ShellNotice>
    );

  if (skills.skills.length === 0)
    return (
      <ShellNotice
        active="stacks"
        handle={handle}
        title="No approved Skills yet"
      >
        <p>
          A Stack can only be built from Skills you&apos;ve already approved
          into Main. Approve at least one Skill first, then come back here.
        </p>
        <p>
          <Link href="/stacks">Back to Stacks</Link>
        </p>
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="stacks"
        handle={handle}
        counts={PLACEHOLDER_SIDEBAR}
        viewing={null}
        machines={[]}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <Link href="/stacks" style={{ color: 'inherit' }}>
              Stacks
            </Link>{' '}
            / New
          </span>
          <div className="stak-sentence">
            <h1>New Stack</h1>
          </div>
          <span className="stak-sub">
            A named, private composition of your approved Skills. It won&apos;t
            affect Main.
          </span>
        </div>
        <div style={{ padding: '22px 32px' }}>
          <NewStackForm approvedSkills={skills.skills} />
        </div>
      </main>
    </div>
  );
}

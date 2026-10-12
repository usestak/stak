import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { ShellNotice } from '../../_components/shell-notice';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import {
  getUserStackDetailAction,
  listApprovedSkillsForPickerAction,
} from '../actions';
import { EditStackForm } from '../_components/edit-stack-form';
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

export default async function EditStackPage({
  params,
}: {
  params: Promise<{ stackId: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { stackId } = await params;
  const handle = user.githubUsername ?? displayNameOf(user);

  const [detailResult, skillsResult] = await Promise.all([
    getUserStackDetailAction(stackId),
    listApprovedSkillsForPickerAction(),
  ]);

  if (!detailResult.ok)
    return (
      <ShellNotice active="stacks" handle={handle} title="Stack not found">
        <p>This Stack doesn&apos;t exist, or isn&apos;t in your account.</p>
        <p>
          <Link href="/stacks">Back to Stacks</Link>
        </p>
      </ShellNotice>
    );
  if (!skillsResult.ok)
    return (
      <ShellNotice active="stacks" handle={handle} title="Couldn't load Skills">
        <p>{skillsResult.error}</p>
      </ShellNotice>
    );

  const { detail } = detailResult;

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
            / {detail.name}
          </span>
          <div className="stak-sentence">
            <h1>{detail.name}</h1>
          </div>
          <span className="stak-sub">
            A named, private Stack. Editing it never changes Main.
          </span>
        </div>
        <div style={{ padding: '22px 32px' }}>
          <EditStackForm detail={detail} approvedSkills={skillsResult.skills} />
        </div>
      </main>
    </div>
  );
}

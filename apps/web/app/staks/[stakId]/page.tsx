import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { ShellNotice } from '../../_components/shell-notice';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import {
  getUserStackDetailAction,
  getUserStackPublicationStatusAction,
  listApprovedSkillsForPickerAction,
} from '../actions';
import { EditStakForm } from '../_components/edit-stak-form';
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

export default async function EditStakPage({
  params,
}: {
  params: Promise<{ stakId: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { stakId } = await params;
  const handle = user.githubUsername ?? displayNameOf(user);

  const [detailResult, skillsResult, publicationResult] = await Promise.all([
    getUserStackDetailAction(stakId),
    listApprovedSkillsForPickerAction(),
    getUserStackPublicationStatusAction(stakId),
  ]);

  if (!detailResult.ok)
    return (
      <ShellNotice active="staks" handle={handle} title="STAK not found">
        <p>This STAK doesn&apos;t exist, or isn&apos;t in your account.</p>
        <p>
          <Link href="/staks">Back to STAKs</Link>
        </p>
      </ShellNotice>
    );
  if (!skillsResult.ok)
    return (
      <ShellNotice active="staks" handle={handle} title="Couldn't load Skills">
        <p>{skillsResult.error}</p>
      </ShellNotice>
    );

  const { detail } = detailResult;

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
            / {detail.name}
          </span>
          <div className="stak-sentence">
            <h1>{detail.name}</h1>
          </div>
          <span className="stak-sub">
            A named, private STAK. Editing it never changes Main.
          </span>
        </div>
        <div style={{ padding: '22px 32px' }}>
          <EditStakForm
            detail={detail}
            approvedSkills={skillsResult.skills}
            initialPublication={
              publicationResult.ok
                ? publicationResult.status
                : { status: 'private' }
            }
          />
        </div>
      </main>
    </div>
  );
}

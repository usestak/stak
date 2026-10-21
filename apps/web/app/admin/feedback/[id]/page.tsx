import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../../_components/admin-sidebar';
import { FeedbackStatusForm } from './feedback-status-form';
import { loadFeedbackDetail } from './feedback-detail-data';

export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const { id } = await params;
  const detail = await loadFeedbackDetail(serviceClient(), id);
  if (!detail) notFound();

  return (
    <>
      <AdminSidebar active="feedback" />
      <main className="stak-admin-main">
        <h1>Feedback detail</h1>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Type</dt>
            <dd>{detail.type}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{detail.status}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{detail.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Source page</dt>
            <dd>{detail.pageUrl ?? '—'}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{detail.appVersion ?? '—'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(detail.createdAt).toLocaleString()}</dd>
          </div>
        </dl>
        <h2>Message</h2>
        <p>{detail.message}</p>
        {detail.goal ? (
          <>
            <h2>What they were trying to do</h2>
            <p>{detail.goal}</p>
          </>
        ) : null}
        <FeedbackStatusForm
          feedbackId={detail.id}
          initialStatus={detail.status}
          initialAdminNote={detail.adminNote ?? ''}
        />
      </main>
    </>
  );
}

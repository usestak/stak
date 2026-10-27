import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadFeedbackList, type FeedbackFilter } from './feedback-data';

const FILTERS: FeedbackFilter[] = [
  'all',
  'new',
  'bugs',
  'confusing',
  'ideas',
  'resolved',
];

const isFeedbackFilter = (value: string | undefined): value is FeedbackFilter =>
  FILTERS.includes(value as FeedbackFilter);

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const filter: FeedbackFilter = isFeedbackFilter(params.filter)
    ? params.filter
    : 'all';
  const items = await loadFeedbackList(serviceClient(), filter);

  return (
    <>
      <AdminSidebar active="feedback" />
      <main className="stak-admin-main">
        <h1>Feedback</h1>
        <nav aria-label="Filter" className="stak-admin-range-pills">
          {FILTERS.map((f) => (
            <a
              key={f}
              href={`/admin/feedback?filter=${f}`}
              className={`stak-admin-nav-link${f === filter ? ' is-active' : ''}`}
            >
              {f}
            </a>
          ))}
        </nav>
        {items.length === 0 ? (
          <p>No feedback yet.</p>
        ) : (
          <div className="stak-admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Message</th>
                  <th>Contact</th>
                  <th>Source page</th>
                  <th>Version</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.type}</td>
                    <td>
                      <Link href={`/admin/feedback/${item.id}`}>
                        {item.messagePreview}
                      </Link>
                    </td>
                    <td>{item.contact ?? '—'}</td>
                    <td>{item.pageUrl ?? '—'}</td>
                    <td>{item.appVersion ?? '—'}</td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

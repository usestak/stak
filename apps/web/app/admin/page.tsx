// apps/web/app/admin/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import {
  ADMIN_DATE_RANGES,
  isAdminDateRange,
  type AdminDateRange,
} from '@/lib/admin-date-range';

import { AdminSidebar } from './_components/admin-sidebar';
import { loadOverviewMetrics } from './overview-data';

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range)
    ? params.range
    : '30d';
  const metrics = await loadOverviewMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="overview" />
      <main className="stak-admin-main">
        <h1>Overview</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {ADMIN_DATE_RANGES.map((r) => (
            <a
              key={r}
              href={`/admin?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Total users</dt>
            <dd>{metrics.totalUsers}</dd>
          </div>
          <div>
            <dt>New users</dt>
            <dd>{metrics.newUsers}</dd>
          </div>
          <div>
            <dt>Activated users</dt>
            <dd>{metrics.activatedUsers}</dd>
          </div>
          <div>
            <dt>Activation rate</dt>
            <dd>
              {metrics.activationRate === null
                ? 'No data yet'
                : `${(metrics.activationRate * 100).toFixed(1)}%`}
            </dd>
          </div>
          <div>
            <dt>Portable users</dt>
            <dd>{metrics.portableUsers}</dd>
          </div>
          <div>
            <dt>New feedback</dt>
            <dd>{metrics.newFeedback}</dd>
          </div>
          <div>
            <dt>Open feedback</dt>
            <dd>{metrics.openFeedback}</dd>
          </div>
          <div>
            <dt>Push/pull success rate</dt>
            <dd>
              See <a href="/admin/reliability">Reliability</a>
            </dd>
          </div>
        </dl>
      </main>
    </>
  );
}

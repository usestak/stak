import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import type { AdminDateRange } from '@/lib/admin-date-range';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadUsageMetrics } from './usage-data';

const RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];
const isAdminDateRange = (value: string | undefined): value is AdminDateRange =>
  RANGES.includes(value as AdminDateRange);

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range) ? params.range : '30d';
  const metrics = await loadUsageMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="usage" />
      <main className="stak-admin-main">
        <h1>Usage</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin/usage?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Active machines</dt>
            <dd>{metrics.activeMachines}</dd>
          </div>
          <div>
            <dt>Memory backups</dt>
            <dd>{metrics.memoryBackupsCount}</dd>
          </div>
          <div>
            <dt>Memory recoveries</dt>
            <dd>{metrics.memoryRecoveriesCount}</dd>
          </div>
          <div>
            <dt>Public STAK publications</dt>
            <dd>{metrics.publicStakPublications}</dd>
          </div>
        </dl>
        <h2>Pushes per day</h2>
        {metrics.pushesPerDay.length === 0 ? (
          <p>No pushes in this period.</p>
        ) : (
          <ul>
            {metrics.pushesPerDay.map((d) => (
              <li key={d.date}>
                {d.date}: {d.count}
              </li>
            ))}
          </ul>
        )}
        <h2>Pulls per day</h2>
        {metrics.pullsPerDay.length === 0 ? (
          <p>No pulls in this period.</p>
        ) : (
          <ul>
            {metrics.pullsPerDay.map((d) => (
              <li key={d.date}>
                {d.date}: {d.count}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

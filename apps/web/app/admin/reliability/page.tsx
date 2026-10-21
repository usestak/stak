import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import type { AdminDateRange } from '@/lib/admin-date-range';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadReliabilityMetrics } from './reliability-data';

const RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];
const isAdminDateRange = (value: string | undefined): value is AdminDateRange =>
  RANGES.includes(value as AdminDateRange);

const pct = (rate: number | null): string => (rate === null ? 'No data yet' : `${(rate * 100).toFixed(1)}%`);

export default async function AdminReliabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range) ? params.range : '30d';
  const metrics = await loadReliabilityMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="reliability" />
      <main className="stak-admin-main">
        <h1>Reliability</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin/reliability?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Push success rate</dt>
            <dd>{pct(metrics.pushSuccessRate)}</dd>
          </div>
          <div>
            <dt>Pull success rate</dt>
            <dd>{pct(metrics.pullSuccessRate)}</dd>
          </div>
          <div>
            <dt>CLI version breakdown</dt>
            <dd>Unavailable — no CLI version header exists yet</dd>
          </div>
        </dl>
        <h2>Recent failures</h2>
        {metrics.recentFailures.length === 0 ? (
          <p>No failures in this period.</p>
        ) : (
          <div className="stak-admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Error code</th>
                  <th>Count</th>
                  <th>Affected users</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentFailures.map((f) => (
                  <tr key={`${f.operation}-${f.errorCode}`}>
                    <td>{f.operation}</td>
                    <td>{f.errorCode}</td>
                    <td>{f.count}</td>
                    <td>{f.affectedUsers}</td>
                    <td>{new Date(f.firstSeen).toLocaleString()}</td>
                    <td>{new Date(f.lastSeen).toLocaleString()}</td>
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

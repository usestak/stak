import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import webPackageJson from '../../../package.json';
import cliPackageJson from '../../../../../packages/cli/package.json';
import { AdminSidebar } from '../_components/admin-sidebar';
import { loadSystemStatus } from './system-data';

export default async function AdminSystemPage() {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const status = await loadSystemStatus(
    serviceClient(),
    webPackageJson.version,
    cliPackageJson.version,
  );

  return (
    <>
      <AdminSidebar active="system" />
      <main className="stak-admin-main">
        <h1>System</h1>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Web app version</dt>
            <dd>{status.webVersion}</dd>
          </div>
          <div>
            <dt>Published CLI version</dt>
            <dd>{status.cliVersion}</dd>
          </div>
          <div>
            <dt>Database connectivity</dt>
            <dd>{status.dbConnected ? 'Connected' : 'Disconnected'}</dd>
          </div>
          <div>
            <dt>Failures (last 24h)</dt>
            <dd>{status.recentFailureCount}</dd>
          </div>
          <div>
            <dt>CLI version breakdown</dt>
            <dd>Unavailable — no CLI version header exists yet</dd>
          </div>
        </dl>
      </main>
    </>
  );
}

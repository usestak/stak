import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadActivationFunnel } from './activation-data';

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'N/A';

export default async function AdminActivationPage() {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const funnel = await loadActivationFunnel(serviceClient());

  return (
    <>
      <AdminSidebar active="activation" />
      <main className="stak-admin-main">
        <h1>Activation</h1>
        <ol>
          <li>Accounts: {funnel.accounts}</li>
          <li>
            CLI-authenticated: {funnel.cliAuthenticated} (
            {pct(funnel.cliAuthenticated, funnel.accounts)})
          </li>
          <li>
            First push: {funnel.firstPush} (
            {pct(funnel.firstPush, funnel.accounts)})
          </li>
          <li>
            Portable: {funnel.portable} ({pct(funnel.portable, funnel.accounts)}
            )
          </li>
        </ol>
      </main>
    </>
  );
}

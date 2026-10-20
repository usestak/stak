// apps/web/app/admin/page.tsx
import { AdminSidebar } from './_components/admin-sidebar';

export default function AdminOverviewPage() {
  return (
    <>
      <AdminSidebar active="overview" />
      <main className="stak-admin-main">
        <h1>Overview</h1>
        <p>Metrics land in Phase 2.</p>
      </main>
    </>
  );
}

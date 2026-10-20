// apps/web/app/admin/users/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadUsers } from './users-data';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const users = await loadUsers(serviceClient(), params.q);

  return (
    <>
      <AdminSidebar active="users" />
      <main className="stak-admin-main">
        <h1>Users</h1>
        <form method="get">
          <input type="search" name="q" defaultValue={params.q ?? ''} placeholder="Search by name" />
        </form>
        {users.length === 0 ? (
          <p>No users yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Joined</th>
                <th>Pushes</th>
                <th>Machines</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId}>
                  <td>{u.displayName}</td>
                  <td>{new Date(u.joinedAt).toLocaleDateString()}</td>
                  <td>{u.pushCount}</td>
                  <td>{u.machineCount}</td>
                  <td>{u.feedbackCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}

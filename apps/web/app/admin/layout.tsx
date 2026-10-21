// apps/web/app/admin/layout.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';

import './admin.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  return <div className="stak-admin">{children}</div>;
}

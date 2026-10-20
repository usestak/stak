// apps/web/app/admin/_components/admin-sidebar.tsx
import Link from 'next/link';

export type AdminNavKey =
  | 'overview'
  | 'users'
  | 'activation'
  | 'usage'
  | 'reliability'
  | 'feedback'
  | 'system';

const NAV: { key: AdminNavKey; label: string; href: string }[] = [
  { key: 'overview', label: 'Overview', href: '/admin' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'activation', label: 'Activation', href: '/admin/activation' },
  { key: 'usage', label: 'Usage', href: '/admin/usage' },
  { key: 'reliability', label: 'Reliability', href: '/admin/reliability' },
  { key: 'feedback', label: 'Feedback', href: '/admin/feedback' },
  { key: 'system', label: 'System', href: '/admin/system' },
];

export function AdminSidebar({ active }: { active: AdminNavKey }) {
  return (
    <nav className="stak-admin-sidebar" aria-label="Admin navigation">
      {NAV.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={`stak-admin-nav-link${item.key === active ? ' is-active' : ''}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

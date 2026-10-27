import Link from 'next/link';

import type { SidebarActiveKey } from './app-sidebar';

const NAV: { key: SidebarActiveKey; label: string; href: string }[] = [
  { key: 'overview', label: 'Overview', href: '/overview' },
  { key: 'skills', label: 'Skills', href: '/skills' },
  { key: 'memory', label: 'Memory', href: '/memory' },
  { key: 'projects', label: 'Projects', href: '/projects' },
  { key: 'machines', label: 'Machines', href: '/machines' },
  { key: 'staks', label: 'STAKs', href: '/staks' },
];

/**
 * Instant navigation feedback for the signed-in shell (rendered by each section's
 * `loading.tsx`). Every dashboard page is dynamic and blocks on several Cloud reads, so
 * without this a click showed nothing until the whole server render finished. Mirrors the
 * `AppSidebar` frame so the real page swaps in without a layout jump; the nav links are
 * real, so the user can keep navigating while a page loads. Counts and the machine
 * selector are omitted — they arrive with the page.
 */
export function AppShellLoading({ active }: { active: SidebarActiveKey }) {
  return (
    <div className="stak-frame">
      <nav className="stak-side" aria-label="Primary">
        <div className="stak-side-topbar">
          <div className="stak-brand">
            <span className="stak-brand-mark">
              <img
                src="/brand/stak-symbol-dark.svg"
                alt=""
                width={16}
                height={16}
              />
              <b>STAK</b>
            </span>
          </div>
        </div>
        <div className="stak-nav-panel">
          <div className="stak-nav">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="stak-nav-item"
                aria-current={active === item.key ? 'page' : undefined}
              >
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
          <div className="stak-foot">
            <Link
              href="/settings"
              className="stak-nav-item"
              aria-current={active === 'settings' ? 'page' : undefined}
            >
              <span>Settings</span>
            </Link>
          </div>
        </div>
      </nav>
      <main id="main-content" className="stak-main" aria-busy="true">
        <span className="sr-only" role="status">
          Loading…
        </span>
        <div className="stak-head" aria-hidden>
          <span className="stak-skel" style={{ width: '42%', height: 24 }} />
          <span className="stak-skel" style={{ width: '64%', height: 14 }} />
        </div>
        <div className="stak-skel-body" aria-hidden>
          <div className="stak-skel-row">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="stak-skel" style={{ height: 72 }} />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="stak-skel"
              style={{ width: `${88 - i * 9}%`, height: 44 }}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

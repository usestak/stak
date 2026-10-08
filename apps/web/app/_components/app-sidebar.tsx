import Link from 'next/link';

import { MachineSelector } from './machine-selector';
import type { SidebarCounts } from '../overview/overview-data';
import type { MachineOption } from '../../lib/machine-context';

const DOT: Record<string, string> = {
  ready: '#84cb8e',
  attention: '#e5b85c',
  neutral: '#a19d94',
};

type NavKey =
  'overview' | 'skills' | 'memory' | 'projects' | 'machines' | 'stacks';

const HREF: Record<NavKey, string> = {
  overview: '/overview',
  skills: '/skills',
  memory: '/memory',
  projects: '/projects',
  machines: '/machines',
  stacks: '/stacks',
};

/**
 * The signed-in application frame (STAK Final Contract): labelled sidebar of six places,
 * "Viewing as <machine>", account handle, Settings + Docs. All six primary destinations —
 * Overview, Skills, Memory, Projects, Machines, Stacks — are real links as of P7.
 * Primary nav is labelled, never icon-only.
 */
export function AppSidebar({
  active,
  handle,
  counts,
  viewing,
  machines,
}: {
  active: NavKey;
  handle: string;
  counts: SidebarCounts;
  viewing: {
    machineId: string;
    name: string;
    statusLabel: string;
    dot: string;
  } | null;
  machines: MachineOption[];
}) {
  const items: { key: NavKey; label: string; n: string; tone: string }[] = [
    {
      key: 'overview',
      label: 'Overview',
      n: counts.overview.n,
      tone: counts.overview.tone,
    },
    { key: 'skills', label: 'Skills', n: counts.skills, tone: 'neutral' },
    {
      key: 'memory',
      label: 'Memory',
      n: counts.memory.n,
      tone: counts.memory.tone,
    },
    { key: 'projects', label: 'Projects', n: counts.projects, tone: 'neutral' },
    { key: 'machines', label: 'Machines', n: counts.machines, tone: 'neutral' },
    { key: 'stacks', label: 'Stacks', n: counts.stacks, tone: 'neutral' },
  ];
  return (
    <nav className="stak-side" aria-label="Primary">
      <div className="stak-brand">
        <b>STAK</b>
        <span>{handle}</span>
      </div>

      {viewing ? (
        <div className="stak-viewing">
          <span className="stak-viewing-label">VIEWING AS</span>
          <MachineSelector current={viewing.machineId} options={machines} />
          <span className="stak-status" style={{ color: '#c9c5bc' }}>
            <span
              className="stak-dot"
              style={{ background: DOT[viewing.dot] }}
              aria-hidden
            />
            {viewing.statusLabel}
          </span>
        </div>
      ) : null}

      <div className="stak-nav">
        {items.map((item) => (
          <Link
            key={item.key}
            href={HREF[item.key]}
            className="stak-nav-item"
            aria-current={active === item.key ? 'page' : undefined}
          >
            <span>{item.label}</span>
            {item.n ? (
              <span
                className="n"
                style={{ color: DOT[item.tone] ?? '#85817a' }}
              >
                {item.n}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      <div className="stak-foot">
        <Link
          href="/settings"
          className="stak-nav-item"
          aria-current={(active as string) === 'settings' ? 'page' : undefined}
        >
          <span>Settings</span>
        </Link>
        <span className="docs">Docs · CLI reference</span>
      </div>
    </nav>
  );
}

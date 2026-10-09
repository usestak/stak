'use client';

import { useEffect, useRef, useState } from 'react';
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

export type SidebarActiveKey = NavKey | 'settings';

const HREF: Record<NavKey, string> = {
  overview: '/overview',
  skills: '/skills',
  memory: '/memory',
  projects: '/projects',
  machines: '/machines',
  stacks: '/stacks',
};

const NAV_PANEL_ID = 'stak-nav-panel';

/**
 * The signed-in application frame (STAK Final Contract): labelled sidebar of six places,
 * "Viewing as <machine>", account handle, Settings + Docs. All six primary destinations —
 * Overview, Skills, Memory, Projects, Machines, Stacks — are real links as of P7.
 * Primary nav is labelled, never icon-only.
 *
 * Renders as a full 216px rail at desktop widths (≥1024px). Below that it collapses to a
 * slim topbar (brand + toggle) with the nav exposed as a keyboard-operable overlay (P9
 * Task 1) — same markup everywhere, visibility is driven by CSS breakpoints rather than a
 * JS media-query duplicate, so there is no layout flash and no hydration mismatch.
 */
export function AppSidebar({
  active,
  handle,
  counts,
  viewing,
  machines,
}: {
  active: SidebarActiveKey;
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
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

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
      <div className="stak-side-topbar">
        <div className="stak-brand">
          <b>STAK</b>
          <span>{handle}</span>
        </div>
        <button
          type="button"
          ref={toggleRef}
          className="stak-nav-toggle"
          aria-expanded={open}
          aria-controls={NAV_PANEL_ID}
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden>{open ? '✕' : '☰'}</span>
        </button>
      </div>

      {open ? (
        <div
          className="stak-backdrop"
          aria-hidden
          onClick={close}
        />
      ) : null}

      <div id={NAV_PANEL_ID} className="stak-nav-panel" data-open={open}>
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
              onClick={close}
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
            aria-current={active === 'settings' ? 'page' : undefined}
            onClick={close}
          >
            <span>Settings</span>
          </Link>
          <span className="docs">Docs · CLI reference</span>
        </div>
      </div>
    </nav>
  );
}

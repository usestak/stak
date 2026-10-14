'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { InlineCommand } from '../../_components/inline-command';
import {
  STATUS_FILTERS,
  filterRows,
  type SkillRow,
  type StatusFilter,
} from '../skills-data';

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  ready: 'Ready',
  'update-available': 'Updates',
  paused: 'Paused',
};

const DOT: Record<string, string> = {
  ready: '#84cb8e',
  attention: '#ee7a3b',
  neutral: '#a19d94',
};

export function SkillsTable({
  rows,
  machineName,
}: {
  rows: SkillRow[];
  machineName: string;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => filterRows(rows, status, query),
    [rows, status, query],
  );

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: rows.length,
      ready: 0,
      'update-available': 0,
      paused: 0,
    };
    for (const r of rows) {
      if (r.statusText === 'Ready') c.ready += 1;
      if (r.primaryStatus === 'update-available') c['update-available'] += 1;
      if (r.primaryStatus === 'paused') c.paused += 1;
    }
    return c;
  }, [rows]);

  if (rows.length === 0)
    return (
      <div className="stak-skills">
        <p className="stak-skills-empty">
          No Skills in STAK yet. That&apos;s expected before your first scan —
          run <InlineCommand command="stak scan" /> on a machine to find the
          ones you already have there.
        </p>
      </div>
    );

  return (
    <div className="stak-skills">
      <div
        className="stak-skills-toolbar"
        role="group"
        aria-label="Filter Skills"
      >
        <div
          className="stak-skills-filters"
          role="radiogroup"
          aria-label="Status"
        >
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={status === f}
              className={`stak-skills-chip${status === f ? ' active' : ''}`}
              onClick={() => setStatus(f)}
            >
              {FILTER_LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="stak-skills-search"
          placeholder="Search Skills"
          aria-label="Search Skills by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="stak-skills-head" role="row">
        <span>SKILL</span>
        <span>SOURCE</span>
        <span>ON {machineName.toUpperCase()}</span>
        <span>STATUS</span>
      </div>

      {filtered.length === 0 ? (
        <p className="stak-skills-empty">No Skills match this filter.</p>
      ) : (
        filtered.map((r) => (
          <Link
            key={r.skillId}
            href={`/skills/${r.skillId}`}
            className="stak-skills-row"
          >
            <span className="stak-skills-name">
              <span className="sr-only">Skill: </span>
              <span className="n">{r.name}</span>
              {r.description ? (
                <span className="d">{r.description}</span>
              ) : null}
            </span>
            <span className="stak-skills-source">
              <span className="sr-only">Source: </span>
              <span className="primary">{r.sourcePrimary}</span>
              <span className="secondary">
                {r.sourceCheckNote ?? r.sourceSecondary}
              </span>
            </span>
            <span className="stak-skills-installed">
              <span className="sr-only">On {machineName}: </span>
              <span className="primary">{r.reconciliationLabel}</span>
              {r.installedShortHash ? (
                <span className="secondary">{r.installedShortHash}</span>
              ) : null}
            </span>
            <span className="stak-status" style={{ color: '#c9c5bc' }}>
              <span
                className="stak-dot"
                style={{ background: DOT[r.dot] }}
                aria-hidden
              />
              <span className="sr-only">Status: </span>
              {r.statusText}
              {r.reviewNote ? (
                <span className="note"> · {r.reviewNote}</span>
              ) : null}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

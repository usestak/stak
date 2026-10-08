'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  STATUS_FILTERS,
  filterProjectRows,
  type ProjectRow,
  type ProjectStatusFilter,
} from '../projects-data';
import { ProjectLifecycleButton } from './project-lifecycle-button';

const FILTER_LABEL: Record<ProjectStatusFilter, string> = {
  all: 'All',
  active: 'Active',
  archived: 'Archived',
};

export function ProjectsTable({
  rows,
  machineName,
}: {
  rows: ProjectRow[];
  machineName: string;
}) {
  const [status, setStatus] = useState<ProjectStatusFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => filterProjectRows(rows, status, query),
    [rows, status, query],
  );

  const counts = useMemo(() => {
    const c: Record<ProjectStatusFilter, number> = { all: rows.length, active: 0, archived: 0 };
    for (const r of rows) c[r.lifecycle] += 1;
    return c;
  }, [rows]);

  return (
    <div className="stak-projects">
      <div className="stak-projects-toolbar" role="group" aria-label="Filter Projects">
        <div className="stak-projects-filters" role="radiogroup" aria-label="Lifecycle">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={status === f}
              className={`stak-projects-chip${status === f ? ' active' : ''}`}
              onClick={() => setStatus(f)}
            >
              {FILTER_LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="stak-projects-search"
          placeholder="Search Projects"
          aria-label="Search Projects by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="stak-projects-head" role="row">
        <span>PROJECT</span>
        <span>LIFECYCLE</span>
        <span>ON {machineName.toUpperCase()}</span>
        <span>MEMORY</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <p className="stak-projects-empty">
          No Projects yet. STAK learns about Projects when a machine checks
          in and reports them — run <code>stak status</code> on a machine
          with Projects STAK can see.
        </p>
      ) : filtered.length === 0 ? (
        <p className="stak-projects-empty">No Projects match this filter.</p>
      ) : (
        filtered.map((r) => (
          <div key={r.projectId} className="stak-projects-row">
            <Link href={`/projects/${r.projectId}`} className="stak-projects-name">
              <span className="n">{r.name}</span>
            </Link>
            <span className="stak-projects-lifecycle">{r.lifecycleLabel}</span>
            <span className="stak-projects-presence">{r.presence}</span>
            <span className="stak-projects-memory">{r.fileCountLabel}</span>
            <ProjectLifecycleButton projectId={r.projectId} lifecycle={r.lifecycle} />
          </div>
        ))
      )}
    </div>
  );
}

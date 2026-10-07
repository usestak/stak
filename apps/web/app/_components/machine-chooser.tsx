'use client';

import { useMemo, useState } from 'react';

import { SEARCH_THRESHOLD, filterOptions } from './machine-selector-logic';

export type ChooserOption = {
  machineId: string;
  name: string;
  secondary: string;
};

/**
 * The "choose a machine" picker (P4 §5/§9) — reuses the SAME bounded/searchable presentation
 * as the Viewing-as selector rather than an arbitrarily long, undecodable list of machine
 * rows. A search field appears once there are enough machines to need one; the visible list is
 * height-bounded with a hidden scrollbar + fade cue, same as the selector popover.
 */
export function MachineChooser({
  options,
  basePath = '/overview',
}: {
  options: ChooserOption[];
  basePath?: string;
}) {
  const [query, setQuery] = useState('');
  const showSearch = options.length > SEARCH_THRESHOLD;
  const filtered = useMemo(
    () => (showSearch ? filterOptions(options, query) : options),
    [options, query, showSearch],
  );

  return (
    <div className="stak-chooser">
      {showSearch ? (
        <input
          type="text"
          className="stak-ms-search"
          placeholder="Search machines"
          aria-label="Search machines"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <div className="stak-ms-fade-wrap">
        <ul className="stak-chooser-list" aria-label="Machines">
          {filtered.length === 0 ? (
            <li className="stak-ms-empty">
              No machines match &quot;{query}&quot;
            </li>
          ) : (
            filtered.map((m) => (
              <li key={m.machineId}>
                <a
                  href={`${basePath}?machine=${encodeURIComponent(m.machineId)}`}
                  className="stak-mcard"
                  style={{
                    textDecoration: 'none',
                    color: 'inherit',
                    display: 'flex',
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {m.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      font: '11px var(--mono)',
                      color: '#85817a',
                    }}
                  >
                    {m.secondary}
                  </span>
                </a>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

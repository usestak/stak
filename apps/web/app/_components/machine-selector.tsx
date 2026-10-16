'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import {
  SEARCH_THRESHOLD,
  filterOptions,
  nextActiveIndex,
} from './machine-selector-logic';
import { setActiveMachinePreference } from './machine-preference-actions';
import { emitSync } from '../../lib/sync/stak-sync';

export type SelectorOption = {
  machineId: string;
  name: string;
  secondary: string;
};

/**
 * "Viewing as <machine>" selector — an accessible dark listbox (not a native system dropdown,
 * which breaks the Control Center look and shows a visible system scrollbar). Primary friendly
 * name + secondary platform/arch/status; bounded to ~5-6 visible rows with a hidden scrollbar
 * and a top/bottom fade cue when more rows exist; a search field appears above the list once
 * there are more than a handful of machines (P4 §3). Keyboard: ↑/↓/Home/End move, Enter
 * selects, Escape/Tab close; visible focus; aria listbox semantics. Selecting updates the URL
 * to `?machine=<id>` (URL context wins). No raw UUID as the primary label; no data leakage.
 */
export function MachineSelector({
  current,
  options,
}: {
  current: string;
  options: SelectorOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  // `isPending` covers the gap between picking a machine and the new server-rendered page
  // actually arriving — without it the selector gave no feedback at all while the request
  // was in flight, making it feel unresponsive. `router.refresh()`-driven RSC navigation
  // (not a client fetch) is what `useTransition` is designed to wrap; no new loading
  // library needed.
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentOption = options.find((o) => o.machineId === current);
  const showSearch = options.length > SEARCH_THRESHOLD;
  const filtered = useMemo(
    () => (showSearch ? filterOptions(options, query) : options),
    [options, query, showSearch],
  );

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  const choose = (machineId: string) => {
    setOpen(false);
    setQuery('');
    if (machineId !== current) {
      // Persist the pick so it survives navigating away from this exact URL
      // (the query param alone doesn't follow you to the next route) — see
      // `lib/machine-preference.ts`. Never awaited: this is a UI convenience,
      // not a gate on the navigation the user is already asking for.
      void setActiveMachinePreference(machineId);
      // Other open tabs have no `?machine=` query param of their own, but they do share this
      // cookie — tell them to refresh so they pick up the new "viewing as" preference too.
      emitSync(['machines', 'sidebar']);
      // Wrapped in a transition so `isPending` is true until the new server-rendered
      // state for the picked machine actually lands — the trigger disables and shows
      // "Switching..." for that whole window, so the old machine's data is never shown
      // under the new selection and a second pick can't be queued mid-flight.
      startTransition(() => {
        router.replace(`${pathname}?machine=${encodeURIComponent(machineId)}`);
      });
    }
  };

  const openMenu = () => {
    setActive(
      Math.max(
        0,
        filtered.findIndex((o) => o.machineId === current),
      ),
    );
    setOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = filtered[active];
      if (picked) choose(picked.machineId);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setActive((i) => nextActiveIndex(i, e.key, filtered.length));
    }
  };

  return (
    <div ref={rootRef} className="stak-ms">
      <button
        type="button"
        className="stak-ms-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={isPending}
        disabled={isPending}
        aria-label={
          isPending
            ? 'Switching machines…'
            : `Viewing as ${currentOption?.name ?? 'a machine'}. Change machine.`
        }
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="stak-ms-name">
          {isPending
            ? 'Switching…'
            : (currentOption?.name ?? 'Choose a machine')}
        </span>
        <span aria-hidden style={{ color: '#85817a', fontSize: 11 }}>
          ▾
        </span>
      </button>
      {open && !isPending ? (
        <div className="stak-ms-popover">
          {showSearch ? (
            <input
              ref={searchRef}
              type="text"
              className="stak-ms-search"
              placeholder="Search machines"
              aria-label="Search machines"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onListKeyDown}
            />
          ) : null}
          <div className="stak-ms-fade-wrap">
            <ul
              className="stak-ms-list"
              role="listbox"
              aria-label="Machines"
              tabIndex={showSearch ? undefined : 0}
              onKeyDown={showSearch ? undefined : onListKeyDown}
            >
              {filtered.length === 0 ? (
                <li className="stak-ms-empty">
                  No machines match &quot;{query}&quot;
                </li>
              ) : (
                filtered.map((o, i) => (
                  <li
                    key={o.machineId}
                    role="option"
                    aria-selected={o.machineId === current}
                    className={`stak-ms-opt${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(o.machineId);
                    }}
                  >
                    <span className="stak-ms-opt-name">{o.name}</span>
                    <span className="stak-ms-opt-sec">{o.secondary}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

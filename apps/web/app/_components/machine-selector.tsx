'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { nextActiveIndex } from './machine-selector-logic';

export type SelectorOption = {
  machineId: string;
  name: string;
  secondary: string;
};

/**
 * "Viewing as <machine>" selector — an accessible dark listbox (not a native system dropdown,
 * which breaks the Control Center look). Primary friendly name + secondary platform/arch/status;
 * keyboard: ↑/↓/Home/End move, Enter selects, Escape/Tab close; visible focus; aria listbox
 * semantics. Selecting updates the URL to `?machine=<id>` (URL context wins). No raw UUID as the
 * primary label; no data leakage.
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.machineId === current),
    ),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const currentOption = options.find((o) => o.machineId === current);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const choose = (machineId: string) => {
    setOpen(false);
    if (machineId !== current)
      router.replace(`${pathname}?machine=${encodeURIComponent(machineId)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (
      !open &&
      (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')
    ) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (open && e.key === 'Enter') {
      e.preventDefault();
      const picked = options[active];
      if (picked) choose(picked.machineId);
      return;
    }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setActive((i) => nextActiveIndex(i, e.key, options.length));
    }
  };

  return (
    <div ref={rootRef} className="stak-ms">
      <button
        type="button"
        className="stak-ms-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Viewing as ${currentOption?.name ?? 'a machine'}. Change machine.`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className="stak-ms-name">
          {currentOption?.name ?? 'Choose a machine'}
        </span>
        <span aria-hidden style={{ color: '#85817a', fontSize: 11 }}>
          ▾
        </span>
      </button>
      {open ? (
        <ul className="stak-ms-list" role="listbox" aria-label="Machines">
          {options.map((o, i) => (
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
          ))}
        </ul>
      ) : null}
    </div>
  );
}

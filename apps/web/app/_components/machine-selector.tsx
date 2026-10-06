'use client';

import { usePathname, useRouter } from 'next/navigation';

/**
 * "Viewing as <machine>" selector. The browser cannot know which physical computer you are at,
 * so machine context is explicit: it comes from `?machine=<id>` (set by `stak open`) or this
 * selector. Changing it updates the URL (URL context takes precedence). Keyboard-operable.
 */
export function MachineSelector({
  current,
  options,
}: {
  current: string;
  options: { machineId: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <select
      className="stak-select"
      value={current}
      aria-label="Viewing as machine"
      onChange={(event) =>
        router.replace(
          `${pathname}?machine=${encodeURIComponent(event.target.value)}`,
        )
      }
    >
      {options.map((option) => (
        <option key={option.machineId} value={option.machineId}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

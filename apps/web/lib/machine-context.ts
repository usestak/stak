import type { MachineSummary } from '@stack/spec';

/** Human-relative time, never a raw timestamp in UI copy. "never" when absent. */
export const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const secs = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/** Human-facing platform label (P4 contract). Display only — never changes storage. */
export const displayPlatform = (
  platform: string | undefined,
): string | undefined => {
  if (!platform) return undefined;
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
};

export const displayName = (m: MachineSummary): string =>
  m.name ?? 'Unnamed machine';
export const shortId = (id: string): string => id.slice(0, 8);
export const checkedIn = (m: MachineSummary): boolean =>
  m.lastCheckinAt !== null;

export const metaLine = (m: MachineSummary): string => {
  const hw = [displayPlatform(m.platform), m.arch].filter(Boolean).join(' · ');
  return hw || `ID ${shortId(m.machineId)}`;
};

export const statusLabel = (m: MachineSummary): string => {
  switch (m.status) {
    case 'never-checked-in':
      return 'No check-in yet';
    case 'updates-waiting':
      return 'Updates waiting';
    case 'up-to-date':
      return `Up to date · ${relative(m.lastCheckinAt)}`;
    default:
      return `Last seen ${relative(m.lastCheckinAt)}`;
  }
};

export const machineDot = (
  m: MachineSummary,
): 'ready' | 'attention' | 'neutral' =>
  m.status === 'up-to-date'
    ? 'ready'
    : m.status === 'updates-waiting'
      ? 'attention'
      : 'neutral';

export type MachineOption = {
  machineId: string;
  name: string;
  secondary: string;
  statusLabel: string;
};

export const machineOption = (m: MachineSummary): MachineOption => ({
  machineId: m.machineId,
  name: displayName(m),
  secondary: `${metaLine(m)} · ${statusLabel(m)}`,
  statusLabel: statusLabel(m),
});

/** Same ordering Overview uses for its machine list/selector (P4 §4): attention-needing
 *  machines first, then checked-in by most recent, then never-checked-in by newest
 *  authorization. Shared so every "Viewing as" selector across the app orders identically. */
export const sortMachinesForSelection = (
  a: MachineSummary,
  b: MachineSummary,
): number => {
  const rank = (m: MachineSummary) =>
    m.status === 'updates-waiting'
      ? 0
      : m.status === 'never-checked-in'
        ? 2
        : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 2) return b.firstSeenAt.localeCompare(a.firstSeenAt);
  return (b.lastCheckinAt ?? '').localeCompare(a.lastCheckinAt ?? '');
};

/** P4's machine-context resolution (contract §20): a valid owned `?machine=` wins; a single
 *  active machine auto-selects; multiple active machines with no/invalid request require the
 *  caller to show a chooser (returns undefined). Revoked machines must already be filtered out
 *  of `active` by the caller. */
export const resolveViewingMachineId = (
  active: MachineSummary[],
  requested: string | undefined,
): string | undefined => {
  const requestedValid =
    requested && active.some((m) => m.machineId === requested);
  if (requestedValid) return requested;
  if (active.length === 1) return active[0]?.machineId;
  return undefined;
};

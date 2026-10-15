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

/** Human-facing agent name — `agentsDetected` stores the raw lowercase AgentId
 *  ('codex' | 'cursor' | 'claude', per `packages/spec/src/adapter.ts`). Display only — never
 *  changes the stored identifier. Unknown ids pass through unchanged rather than guessing. */
export const displayAgent = (id: string): string => {
  switch (id) {
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'claude':
      return 'Claude Code';
    default:
      return id;
  }
};

/** Deterministic short discriminator derived from the machine's own stable `machineId` —
 *  never from list order or position, so the same machine always gets the same suffix
 *  regardless of how/when the active list was fetched. 4 uppercase hex chars is enough to
 *  tell two same-named machines apart without exposing the full raw id. */
const discriminator = (machineId: string): string =>
  machineId.replace(/-/g, '').slice(-4).toUpperCase();

/** Hostname-based display name for a machine, disambiguated against the rest of the
 *  account's active machines when `all` is supplied. `stak login --label` is a one-time
 *  CLI-token label shown only on the approval screen (see `cloud-server/service.ts`'s
 *  `PendingCliAuthSessionView`) — it is never persisted as a machine nickname, so there is
 *  currently no safe explicit user-set label to prefer over the hostname. Two machines
 *  sharing a hostname (including two isolated homes on one physical machine) get a short,
 *  stable `HOSTNAME · XXXX` suffix instead of being indistinguishable. */
export const displayName = (
  m: MachineSummary,
  all?: readonly MachineSummary[],
): string => {
  const base = m.name ?? 'Unnamed machine';
  if (!all) return base;
  const collides = all.some(
    (other) =>
      other.machineId !== m.machineId &&
      (other.name ?? 'Unnamed machine') === base,
  );
  return collides ? `${base} · ${discriminator(m.machineId)}` : base;
};
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

/** Frozen stale threshold (contract §11, "machine not seen in 30+ days"). A separate fact
 *  from status — a machine can be up to date on skills yet still be stale by check-in age. */
const STALE_DAYS = 30;
export const isStale = (m: MachineSummary): boolean => {
  if (m.lastCheckinAt === null) return false;
  const days = (Date.now() - new Date(m.lastCheckinAt).getTime()) / 86_400_000;
  return days >= STALE_DAYS;
};

export type MachineOption = {
  machineId: string;
  name: string;
  secondary: string;
  statusLabel: string;
};

export const machineOption = (
  m: MachineSummary,
  all?: readonly MachineSummary[],
): MachineOption => ({
  machineId: m.machineId,
  name: displayName(m, all),
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

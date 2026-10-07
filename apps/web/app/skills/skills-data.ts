import type { CloudService } from '@stack/cloud-server';
import type { SkillSummary } from '@stack/spec';

import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';
import type { WebUser } from '../../lib/session.js';

export type SkillsService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getSkillsReadModel'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type SkillRow = {
  skillId: string;
  name: string;
  description?: string;
  sourceLabel: string;
  sourceCheckNote?: string;
  // Present only when a real update was found but Cloud holds no reviewable artifact for it
  // (a REVIEW CAPABILITY fact, distinct from the SOURCE fact `statusText === 'Update available'`
  // already communicates). Never changes the primary status/badge.
  reviewNote?: string;
  installedLabel: string;
  primaryStatus: 'ready' | 'update-available' | 'paused';
  pendingInstall: boolean;
  dot: 'ready' | 'attention' | 'neutral';
  statusText: string;
};

/** Secondary, non-badge explanation for why a found update has no reviewable artifact. */
const reviewNote = (
  reason: SkillSummary['reviewUnavailableReason'],
): string | undefined =>
  reason === 'exceeds-review-bounds'
    ? 'This update is too large to review in STAK Cloud.'
    : undefined;

/** Maps a non-actionable sourceCheckState to the explanatory note shown alongside the source
 *  label (contract §2/§3). 'no-update' and 'update-available' need no note — the primary status
 *  already communicates them. */
const sourceCheckNote = (
  state: SkillSummary['sourceCheckState'],
): string | undefined => {
  switch (state) {
    case 'not-checked':
      return "Updates haven't been checked yet.";
    case 'cannot-check':
      return "Can't check for updates from this source.";
    case 'check-failed':
      return 'Check failed.';
    default:
      return undefined;
  }
};

export const STATUS_FILTERS = [
  'all',
  'ready',
  'update-available',
  'paused',
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Primary status derivation (contract §19 + the Final Contract's frozen `lang` table).
 * Ready REQUIRES !paused AND installed === approved on the viewing machine at its last
 * check-in. "Cannot check source" is a SOURCE annotation (§2/§3) — it rides alongside the
 * primary status on the SOURCE column, never replaces Ready/Update available/Paused.
 * Resolved ambiguity: when not paused and no source update, but the viewing machine never
 * reported or reports a different version, the row is NEVER "Ready" — it gets a neutral dot
 * and plain text, not a 4th badge word.
 */
export const deriveRow = (
  skill: SkillSummary,
  viewingMachineId: string,
  viewingMachineCheckedIn: boolean,
): SkillRow => {
  const install = skill.installs.find((i) => i.machineId === viewingMachineId);
  const installedHere =
    viewingMachineCheckedIn && install
      ? install.installedVersion === skill.approvedVersion
      : false;

  let primaryStatus: SkillRow['primaryStatus'];
  let dot: SkillRow['dot'];
  let statusText: string;
  if (skill.paused) {
    primaryStatus = 'paused';
    dot = 'neutral';
    statusText = 'Paused';
  } else if (skill.sourceCheckState === 'update-available') {
    primaryStatus = 'update-available';
    dot = 'attention';
    statusText = 'Update available';
  } else if (!viewingMachineCheckedIn) {
    primaryStatus = 'ready'; // bucketed with Ready-eligible for filtering; NOT labeled Ready
    dot = 'neutral';
    statusText = 'Not reported here yet';
  } else if (!install) {
    primaryStatus = 'ready';
    dot = 'neutral';
    statusText = 'Not installed here';
  } else if (!installedHere) {
    primaryStatus = 'ready';
    dot = 'neutral';
    statusText = 'Different version here';
  } else {
    primaryStatus = 'ready';
    dot = 'ready';
    statusText = 'Ready';
  }

  return {
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    sourceLabel:
      skill.source.label ??
      (skill.source.kind === 'local' ? 'Local' : skill.source.kind),
    ...(sourceCheckNote(skill.sourceCheckState)
      ? { sourceCheckNote: sourceCheckNote(skill.sourceCheckState) }
      : {}),
    ...(reviewNote(skill.reviewUnavailableReason)
      ? { reviewNote: reviewNote(skill.reviewUnavailableReason) }
      : {}),
    installedLabel: install
      ? install.installedVersion
        ? install.installedVersion.slice(7, 15)
        : 'Not installed here'
      : 'Not reported here',
    primaryStatus,
    pendingInstall:
      !skill.paused &&
      skill.sourceCheckState !== 'update-available' &&
      statusText !== 'Ready',
    dot,
    statusText,
  };
};

/** The three truthful filter groups required by contract §6, plus "all". Filtering excludes
 *  rows that are only "Ready-eligible but not confirmed installed" from the Ready bucket,
 *  matching §19 — such rows only show under "All". */
export const filterRows = (
  rows: SkillRow[],
  status: StatusFilter,
  query: string,
): SkillRow[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (status === 'all') return true;
    if (status === 'ready')
      return r.primaryStatus === 'ready' && r.statusText === 'Ready';
    return r.primaryStatus === status;
  });
};

export type SkillsListView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: string;
      };
      machines: MachineOption[];
      sidebar: SidebarCounts;
      statusSentence: string;
      rows: SkillRow[];
      dockCommand: string;
    };

export const loadSkillsList = async (
  service: SkillsService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<SkillsListView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  let skillsModel;
  try {
    [machinesModel, skillsModel] = await Promise.all([
      service.getMachinesReadModel(auth),
      service.getSkillsReadModel(auth),
    ]);
  } catch {
    return { kind: 'error' };
  }

  const active = machinesModel.machines.filter((m) => !m.revoked);
  if (active.length === 0) return { kind: 'no-machines' };

  const ordered = [...active].sort(sortMachinesForSelection);
  const options = ordered.map(machineOption);
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);

  const rows = skillsModel.skills
    .map((s) => deriveRow(s, viewingId, viewingCheckedIn))
    .sort((a, b) => a.name.localeCompare(b.name));

  const readyCount = rows.filter((r) => r.statusText === 'Ready').length;
  const updateCount = rows.filter(
    (r) => r.primaryStatus === 'update-available',
  ).length;

  const statusSentence = !viewingCheckedIn
    ? `${viewingName} hasn't reported installed Skill state yet.`
    : rows.length === 0
      ? 'No Skills in STAK yet.'
      : updateCount > 0
        ? `${updateCount} Skill${updateCount === 1 ? '' : 's'} ${updateCount === 1 ? 'has' : 'have'} updates to review.`
        : `${readyCount} Skill${readyCount === 1 ? '' : 's'} ${readyCount === 1 ? 'is' : 'are'} ready on ${viewingName}.`;

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar: {
      overview: { n: '', tone: 'neutral' },
      skills: String(rows.length),
      memory: { n: '', tone: 'neutral' },
      projects: '',
      machines: String(active.length),
      stacks: '',
    },
    statusSentence,
    rows,
    dockCommand: 'stak skill update',
  };
};

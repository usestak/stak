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
import {
  cliSkillSelector,
  machineReconciliation,
  sourceCheckNote,
  sourcePresentation,
  type MachineReconciliationState,
} from '../../lib/skill-presentation.js';
import type { SidebarCounts } from '../overview/overview-data.js';
import type { WebUser } from '../../lib/session.js';
import { loadSidebarSummary } from '../../lib/sidebar-summary.js';
import { webAuth } from '../../lib/web-auth.js';

export type SkillsService = Pick<
  CloudService,
  | 'getMachinesReadModel'
  | 'getSkillsReadModel'
  | 'getOverview'
  | 'listUserStacks'
>;
const shortHash = (hash: string) => hash.slice(7, 15);

export type SkillRow = {
  skillId: string;
  name: string;
  description?: string;
  sourcePrimary: string;
  sourceSecondary?: string;
  sourceCheckNote?: string;
  // Present only when a real update was found but Cloud holds no reviewable artifact for it
  // (a REVIEW CAPABILITY fact, distinct from the SOURCE fact `statusText === 'Update available'`
  // already communicates). Never changes the primary status/badge.
  reviewNote?: string;
  reconciliationState: MachineReconciliationState;
  reconciliationLabel: string;
  /** Short content hash, technical/secondary only — never the primary machine-state value. */
  installedShortHash?: string;
  primaryStatus: 'ready' | 'update-available' | 'paused';
  pendingInstall: boolean;
  dot: 'ready' | 'attention' | 'neutral';
  statusText: string;
  cliSelector: string;
};

/** Secondary, non-badge explanation for why a found update has no reviewable artifact. */
const reviewNote = (
  reason: SkillSummary['reviewUnavailableReason'],
): string | undefined =>
  reason === 'exceeds-review-bounds'
    ? 'This update is too large to review in STAK Cloud.'
    : undefined;

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
  allSkills: readonly { skillId: string; name: string }[],
): SkillRow => {
  const install = skill.installs.find((i) => i.machineId === viewingMachineId);
  const reconciliation = machineReconciliation(
    install,
    skill.approvedVersion,
    viewingMachineCheckedIn,
  );
  const installedHere = reconciliation.state === 'matches-approved';

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
  } else if (!installedHere) {
    // Bucketed with Ready-eligible for filtering (§19); NOT labeled Ready. The reconciliation
    // column already carries the precise reason (Not reported / Not installed / Approved
    // version not installed) — the status column doesn't repeat it.
    primaryStatus = 'ready';
    dot = 'neutral';
    statusText = 'Not ready';
  } else {
    primaryStatus = 'ready';
    dot = 'ready';
    statusText = 'Ready';
  }

  const source = sourcePresentation(skill.source);

  return {
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    sourcePrimary: source.primary,
    ...(source.secondary ? { sourceSecondary: source.secondary } : {}),
    ...(sourceCheckNote(skill.sourceCheckState)
      ? { sourceCheckNote: sourceCheckNote(skill.sourceCheckState) }
      : {}),
    ...(reviewNote(skill.reviewUnavailableReason)
      ? { reviewNote: reviewNote(skill.reviewUnavailableReason) }
      : {}),
    reconciliationState: reconciliation.state,
    reconciliationLabel: reconciliation.label,
    ...(install?.installedVersion
      ? { installedShortHash: shortHash(install.installedVersion) }
      : {}),
    primaryStatus,
    pendingInstall:
      !skill.paused &&
      skill.sourceCheckState !== 'update-available' &&
      !installedHere,
    dot,
    statusText,
    cliSelector: cliSkillSelector(skill.skillId, skill.name, allSkills),
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
      /** The page-level status dot — matches the sentence it sits next to (§5): green only
       *  when every Skill is genuinely Ready, amber when any has an update to review, neutral
       *  otherwise (mixed/unknown/not-yet-reported states). Never an unexplained neutral dot
       *  on a page that just said everything is Ready. */
      statusDot: 'ready' | 'attention' | 'neutral';
      /** Secondary, source-health sentence — only when it adds real information beyond the
       *  primary machine-reconciliation sentence (§5). Derived from real counts; omitted when
       *  there is nothing truthful and useful to add. */
      sourceHealthSentence?: string;
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
  const options = ordered.map((m) => machineOption(m, active));
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing, active);
  const viewingCheckedIn = checkedIn(viewing);

  const allSkills = skillsModel.skills.map((s) => ({
    skillId: s.skillId,
    name: s.name,
  }));
  const rows = skillsModel.skills
    .map((s) => deriveRow(s, viewingId, viewingCheckedIn, allSkills))
    .sort((a, b) => a.name.localeCompare(b.name));

  const readyCount = rows.filter((r) => r.statusText === 'Ready').length;
  const updateCount = rows.filter(
    (r) => r.primaryStatus === 'update-available',
  ).length;
  const cannotCheckCount = rows.filter(
    (r) => r.sourceCheckNote === "Can't check for updates from this source.",
  ).length;
  const notCheckedCount = rows.filter(
    (r) => r.sourceCheckNote === "Updates haven't been checked yet.",
  ).length;

  const statusSentence = !viewingCheckedIn
    ? `${viewingName} hasn't reported installed Skill state yet.`
    : rows.length === 0
      ? 'No Skills in STAK yet.'
      : updateCount > 0
        ? `${updateCount} Skill${updateCount === 1 ? '' : 's'} ${updateCount === 1 ? 'has' : 'have'} updates to review.`
        : `${readyCount} Skill${readyCount === 1 ? '' : 's'} ${readyCount === 1 ? 'is' : 'are'} ready on ${viewingName}.`;

  const statusDot: 'ready' | 'attention' | 'neutral' =
    updateCount > 0
      ? 'attention'
      : viewingCheckedIn && rows.length > 0 && readyCount === rows.length
        ? 'ready'
        : 'neutral';

  const sourceHealthSentence =
    updateCount === 0 && rows.length > 0
      ? cannotCheckCount === rows.length
        ? `${cannotCheckCount} Skill${cannotCheckCount === 1 ? '' : 's'} can't be checked for upstream updates.`
        : cannotCheckCount > 0
          ? `${cannotCheckCount} of ${rows.length} Skills can't be checked for upstream updates.`
          : notCheckedCount > 0
            ? `${notCheckedCount} Skill${notCheckedCount === 1 ? '' : 's'} ${notCheckedCount === 1 ? 'hasn’t' : 'haven’t'} been checked for updates yet.`
            : undefined
      : undefined;

  // `.skills` is this page's own authoritative count (`rows.length`, the same list
  // rendered below) — every other badge comes from the one shared loader.
  const sidebar = {
    ...(await loadSidebarSummary(service, user, viewingId, active.length)),
    skills: String(rows.length),
  };

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar,
    statusSentence,
    statusDot,
    ...(sourceHealthSentence ? { sourceHealthSentence } : {}),
    rows,
    dockCommand: 'stak skill update',
  };
};

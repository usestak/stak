import type { CloudService } from '@stack/cloud-server';
import type { OwnedStackSummary, SkillSummary } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';
import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  relative,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';
import { loadSidebarSummary } from '../../lib/sidebar-summary.js';

export type StacksService = Pick<
  CloudService,
  | 'getMachinesReadModel'
  | 'getOverview'
  | 'getStacksReadModel'
  | 'getSkillsReadModel'
  | 'listUserStacks'
>;

/**
 * Only desired-state facts (contract §6/§17): `paused` here comes straight from the resolved
 * environment bundle's own `paused` flag — the Stack's OWN desired composition, not any
 * machine's installed/reconciliation state. Deliberately carries no version identity: the
 * environment only has a content hash, never a human-readable version, and manufacturing one
 * (or showing the hash) would misrepresent an internal implementation detail as a product
 * fact (contract §5/§7).
 */
export type StackSkillRow = {
  skillId: string;
  name: string;
  paused: boolean;
};

export type StackCard = {
  name: string;
  environmentId: string;
  versionLabel: string;
  skillCount: number;
  updatedAtLabel: string;
  skills: StackSkillRow[];
};

/**
 * One row in the "Saved Stacks" list (P10B §11) — a named, private, reusable composition of
 * approved Skills, independent of `main` (the always-active desired environment above it).
 * Deliberately carries no machine-installed/reconciliation state (contract §6/§17, same rule
 * as {@link StackSkillRow}): a saved Stack's row is composition facts only.
 */
export type SavedStackRow = {
  stackId: string;
  name: string;
  skillCount: number;
  versionLabel: string;
  updatedAtLabel: string;
};

const toStackCard = (
  owned: OwnedStackSummary,
  skills: SkillSummary[],
): StackCard => ({
  name: owned.name,
  environmentId: owned.environmentId,
  versionLabel:
    owned.latestVersionNumber === null
      ? 'No version yet'
      : `Version ${owned.latestVersionNumber}`,
  skillCount: owned.skillCount,
  updatedAtLabel:
    owned.updatedAt === null ? 'Never' : relative(owned.updatedAt),
  skills: [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      skillId: s.skillId,
      name: s.name,
      paused: s.paused,
    })),
});

export type StacksView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: 'ready' | 'attention' | 'neutral';
      };
      machines: MachineOption[];
      sidebar: SidebarCounts;
      statusSentence: string;
      owned: StackCard | null;
      savedStacks: SavedStackRow[];
    };

export const loadStacksView = async (
  service: StacksService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<StacksView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  try {
    machinesModel = await service.getMachinesReadModel(auth);
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

  let ownedSummaries: OwnedStackSummary[];
  let skills: SkillSummary[];
  let savedStacks: SavedStackRow[];
  try {
    const [stacksModel, skillsModel, userStacksModel] = await Promise.all([
      service.getStacksReadModel(auth),
      service.getSkillsReadModel(auth),
      service.listUserStacks(auth),
    ]);
    ownedSummaries = stacksModel.owned;
    skills = skillsModel.skills;
    savedStacks = [...userStacksModel.stacks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        stackId: s.stackId,
        name: s.name,
        skillCount: s.skillCount,
        versionLabel:
          s.versionNumber === 0
            ? 'No version yet'
            : `Version ${s.versionNumber}`,
        updatedAtLabel: s.updatedAt === null ? 'Never' : relative(s.updatedAt),
      }));
  } catch {
    return { kind: 'error' };
  }

  const owned = ownedSummaries[0]
    ? toStackCard(ownedSummaries[0], skills)
    : null;

  const statusSentence = owned
    ? owned.skillCount === 0
      ? `Your ${owned.name} STAK is empty.`
      : `Your ${owned.name} STAK has ${owned.skillCount} Skill${owned.skillCount === 1 ? '' : 's'}.`
    : "You don't have a STAK yet.";

  const sidebar = await loadSidebarSummary(
    service,
    user,
    viewingId,
    active.length,
  );

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing, active),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar,
    statusSentence,
    owned,
    savedStacks,
  };
};

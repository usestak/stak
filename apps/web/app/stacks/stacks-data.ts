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

export type StacksService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getStacksReadModel' | 'getSkillsReadModel'
>;

const shortHash = (hash: string) => hash.slice(7, 15);

export type StackSkillRow = {
  skillId: string;
  name: string;
  approvedVersionShort: string;
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

const toStackCard = (
  owned: OwnedStackSummary,
  skills: SkillSummary[],
): StackCard => ({
  name: owned.name,
  environmentId: owned.environmentId,
  versionLabel:
    owned.latestVersionNumber === null
      ? 'No version yet'
      : `v${owned.latestVersionNumber}`,
  skillCount: owned.skillCount,
  updatedAtLabel:
    owned.updatedAt === null ? 'Never' : relative(owned.updatedAt),
  skills: [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      skillId: s.skillId,
      name: s.name,
      approvedVersionShort: shortHash(s.approvedVersion),
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
  const options = ordered.map(machineOption);
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;

  let ownedSummaries: OwnedStackSummary[];
  let skills: SkillSummary[];
  try {
    const [stacksModel, skillsModel] = await Promise.all([
      service.getStacksReadModel(auth),
      service.getSkillsReadModel(auth),
    ]);
    ownedSummaries = stacksModel.owned;
    skills = skillsModel.skills;
  } catch {
    return { kind: 'error' };
  }

  const owned = ownedSummaries[0]
    ? toStackCard(ownedSummaries[0], skills)
    : null;

  const statusSentence = owned
    ? owned.skillCount === 0
      ? `${owned.name} is empty.`
      : `${owned.name} has ${owned.skillCount} Skill${owned.skillCount === 1 ? '' : 's'}.`
    : "You don't have a Stack yet.";

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar: {
      overview: { n: '', tone: 'neutral' },
      skills: '',
      memory: { n: '', tone: 'neutral' },
      projects: '',
      machines: '',
      stacks: owned ? '1' : '0',
    },
    statusSentence,
    owned,
  };
};

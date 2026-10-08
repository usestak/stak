import type { CloudService } from '@stack/cloud-server';
import type { MachineSummary } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';
import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  metaLine,
  checkedIn,
  isStale,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';

export type MachinesService = Pick<
  CloudService,
  'getMachinesReadModel' | 'revokeMachine'
>;

export type MachineCard = {
  machineId: string;
  name: string;
  meta: string;
  statusLabel: string;
  dot: 'ready' | 'attention' | 'neutral';
  stale: boolean;
  skillsLabel: string;
  projectsLabel: string;
  memoryLabel: string;
  agentsLabel: string;
  isOnlyActiveMachine: boolean;
};

const NO_CHECKIN = 'No check-in yet';

const skillsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  if (m.updatesWaiting.length > 0)
    return `${m.updatesWaiting.length} update${m.updatesWaiting.length === 1 ? '' : 's'} waiting`;
  return 'Up to date';
};

const projectsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  return `${m.projectsPresent} project${m.projectsPresent === 1 ? '' : 's'}`;
};

const memoryLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  return m.memoryBackedUp
    ? 'Backed up on this machine'
    : 'Not fully backed up here';
};

const agentsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  return m.agentsDetected.length > 0
    ? m.agentsDetected.join(', ')
    : 'None detected';
};

const toCard = (m: MachineSummary, onlyActive: boolean): MachineCard => ({
  machineId: m.machineId,
  name: displayName(m),
  meta: metaLine(m),
  statusLabel: statusLabel(m),
  dot: machineDot(m),
  stale: isStale(m),
  skillsLabel: skillsLabel(m),
  projectsLabel: projectsLabel(m),
  memoryLabel: memoryLabel(m),
  agentsLabel: agentsLabel(m),
  isOnlyActiveMachine: onlyActive,
});

/** The literal, real "new machine" sequence (contract §9/§12 command language) — static,
 *  not derived, because it never changes per account. */
export const NEW_MACHINE_STEPS: { command: string; hint: string }[] = [
  { command: 'stak login', hint: 'approve the machine' },
  {
    command: 'stak memory recover',
    hint: 'Cloud → this machine (passkey or recovery file)',
  },
  { command: 'stak memory restore', hint: "into your agents' Memory" },
  { command: 'stak project map', hint: 'in each project folder' },
];

export type MachinesView =
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
      cards: MachineCard[];
      updatesWaitingCards: MachineCard[];
    };

export const loadMachinesView = async (
  service: MachinesService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<MachinesView> => {
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
  const onlyActive = active.length === 1;
  const cards = ordered.map((m) => toCard(m, onlyActive));
  const updatesWaitingCards = cards.filter((c) =>
    c.skillsLabel.endsWith('waiting'),
  );

  const attentionCount = cards.filter(
    (c) => c.dot === 'attention' || c.stale || c.statusLabel === NO_CHECKIN,
  ).length;

  const statusSentence =
    active.length === 1
      ? attentionCount === 0
        ? `Your STAK is on ${displayName(viewing)}.`
        : `Your STAK is on ${displayName(viewing)}. It needs attention.`
      : attentionCount === 0
        ? `Your STAK is on ${active.length} machines.`
        : `Your STAK is on ${active.length} machines. ${attentionCount} need${attentionCount === 1 ? 's' : ''} attention.`;

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
      machines: String(active.length),
      stacks: '',
    },
    statusSentence,
    cards,
    updatesWaitingCards,
  };
};

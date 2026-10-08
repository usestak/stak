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
  relative,
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
  updatesWaitingCount: number;
  isOnlyActiveMachine: boolean;
};

const NO_CHECKIN = 'No check-in yet';

/**
 * Every fact below describes what the machine reported at its LAST check-in, not a live
 * connection (contract §3: "Up to date" must always appear with the relevant check-in time —
 * generalized here to every fact, not just the status word, since "Up to date" and "backed
 * up" read as present-tense claims in isolation). Each cell names the actual check-in time
 * itself rather than relying on the card's separate status badge to supply that context — a
 * reader scanning just this grid must not be able to mistake it for live state.
 */
const asOf = (m: MachineSummary): string =>
  `as of ${relative(m.lastCheckinAt)}`;

const skillsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  if (m.updatesWaiting.length > 0)
    return `${m.updatesWaiting.length} update${m.updatesWaiting.length === 1 ? '' : 's'} waiting · ${asOf(m)}`;
  return `Up to date · ${asOf(m)}`;
};

/**
 * `projectsPresent` is a required field of every check-in payload (never best-effort — unlike
 * the separate Cloud Project-registry sync), computed by enumerating every Project the CLI's
 * local registry knows and reporting presence for each. So for a machine that has checked in,
 * 0 is a real, measured fact — not an absence of reporting — and is shown as a number, scoped
 * to the check-in that measured it.
 */
const projectsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  return `${m.projectsPresent} project${m.projectsPresent === 1 ? '' : 's'} · ${asOf(m)}`;
};

const memoryLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  return m.memoryBackedUp
    ? `Backed up · ${asOf(m)}`
    : `Not fully backed up · ${asOf(m)}`;
};

const agentsLabel = (m: MachineSummary): string => {
  if (!checkedIn(m)) return NO_CHECKIN;
  const names =
    m.agentsDetected.length > 0 ? m.agentsDetected.join(', ') : 'None detected';
  return `${names} · ${asOf(m)}`;
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
  updatesWaitingCount: m.updatesWaiting.length,
  isOnlyActiveMachine: onlyActive,
});

/**
 * The real "new machine" sequence (contract §9/§12 command language) — static, not derived,
 * because it never changes per account. Step 4 is deliberately NOT a bare copy-pasteable
 * command: the real CLI syntax is `stak project map <project> <directory>`, which needs a
 * Project selector and a local directory, and may not be needed at all when canonical
 * resolution already matches a Project without an explicit binding. Presenting it as a
 * complete command would be inventing syntax that doesn't run as shown, so its `title` is a
 * semantic instruction and its `syntax` is reference-only, not something to copy verbatim.
 */
export const NEW_MACHINE_STEPS: {
  title: string;
  syntax: string;
  copyable: boolean;
  hint: string;
}[] = [
  {
    title: 'stak login',
    syntax: 'stak login',
    copyable: true,
    hint: 'approve the machine',
  },
  {
    title: 'stak memory recover',
    syntax: 'stak memory recover',
    copyable: true,
    hint: 'Cloud → this machine (passkey or recovery file)',
  },
  {
    title: 'stak memory restore',
    syntax: 'stak memory restore',
    copyable: true,
    hint: "into your agents' Memory",
  },
  {
    title: 'Map Projects if needed',
    syntax: 'stak project map <project> <directory>',
    copyable: false,
    hint: 'run `stak project` first — most Projects resolve on their own and need no mapping',
  },
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
  const updatesWaitingCards = cards.filter((c) => c.updatesWaitingCount > 0);

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

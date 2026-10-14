import type { CloudService } from '@stack/cloud-server';
import type { MemoryReadModel } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';
import {
  relative,
  displayName,
  checkedIn,
  statusLabel,
  machineDot,
  machineOption,
  sortMachinesForSelection,
  resolveViewingMachineId,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';

export type MemoryService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getMemoryReadModel' | 'getProjectsReadModel'
>;

export type MemoryHistoryRow = {
  generation: number;
  mode: MemoryReadModel['mode'];
  createdAt: string;
  when: string;
  isLatest: boolean;
};

export type MemoryPerProjectRow = {
  projectId: string;
  name: string;
  fileCount: number;
};

export type MemoryView =
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
      mode: MemoryReadModel['mode'];
      backedUp: boolean;
      /** True only when the SELECTED, checked-in machine's own local backup manifest is behind
       *  (contract: account Cloud-backup truth is kept separate from machine-level local-backup
       *  truth — never collapsed into one boolean). */
      machineGap: boolean;
      /** True once the viewing machine has ever checked in. False means STAK has no backup
       *  data for it at all — never render that as "up to date" (would be a fabricated claim). */
      viewingCheckedIn: boolean;
      statusSentence: string;
      machineSentence: string;
      modeSentence: string;
      hasRecoveryMethod: boolean;
      needsRecoveryMethod: boolean;
      history: MemoryHistoryRow[];
      /** Standard-only; always null for Protected (contract §1/§7/§8 — never fabricated). */
      perProject: MemoryPerProjectRow[] | null;
      /** Protected-only honest substitute: how many Projects the Cloud registry independently
       *  knows about, NOT derived from decrypted Memory content. */
      protectedProjectsKnownCount: number;
      dockCommand: string;
      dockHint: string;
    };

export const loadMemoryView = async (
  service: MemoryService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<MemoryView> => {
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
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);

  let memory: MemoryReadModel;
  let projects;
  try {
    const [m, p] = await Promise.all([
      service.getMemoryReadModel(auth),
      service.getProjectsReadModel(auth),
    ]);
    memory = m;
    projects = p.projects;
  } catch {
    return { kind: 'error' };
  }

  const backedUp = memory.latestBackupAt !== null;
  const machineGap = viewingCheckedIn && !viewing.memoryBackedUp;

  const statusSentence = !backedUp
    ? 'Not backed up yet.'
    : `Backed up — latest ${relative(memory.latestBackupAt)}.`;

  const machineSentence = !viewingCheckedIn
    ? `${viewingName} hasn't checked in yet.`
    : machineGap
      ? `At ${viewingName}'s last check-in (${relative(viewing.lastCheckinAt)}), it had Memory changes that weren't backed up.`
      : `${viewingName} was up to date at its last check-in, ${relative(viewing.lastCheckinAt)}.`;

  const modeSentence =
    memory.mode === 'protected'
      ? "Protected, account-wide: encrypted on your machine. STAK stores ciphertext and can't read it."
      : memory.mode === 'standard'
        ? "Standard, account-wide: private to your account; STAK's service can read it to deliver it."
        : 'No Memory mode set yet.';

  const needsRecoveryMethod =
    memory.mode === 'protected' && !memory.hasRecoveryMethod;

  const history: MemoryHistoryRow[] = memory.backups.map((b, i) => ({
    generation: b.generation,
    mode: b.mode,
    createdAt: b.createdAt,
    when: relative(b.createdAt),
    isLatest: i === 0,
  }));

  const nameById = new Map(projects.map((p) => [p.projectId, p.name]));
  const perProject: MemoryPerProjectRow[] | null =
    memory.mode === 'standard' && memory.perProject
      ? memory.perProject.map((row) => ({
          projectId: row.projectId,
          name: nameById.get(row.projectId) ?? row.projectId,
          fileCount: row.fileCount,
        }))
      : null;

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
      skills: '',
      memory: backedUp
        ? { n: 'Backed up', tone: 'ready' }
        : { n: '', tone: 'neutral' },
      projects: '',
      machines: String(active.length),
      staks: '',
    },
    mode: memory.mode,
    backedUp,
    machineGap,
    viewingCheckedIn,
    statusSentence,
    machineSentence,
    modeSentence,
    hasRecoveryMethod: memory.hasRecoveryMethod,
    needsRecoveryMethod,
    history,
    perProject,
    protectedProjectsKnownCount: projects.length,
    dockCommand: 'stak memory backup',
    dockHint: machineGap
      ? `Backs up ${viewingName}'s current Memory to STAK Cloud.`
      : 'Creates a new backup generation.',
  };
};

import type { CloudService } from '@stack/cloud-server';
import type { MemoryReadModel, ProjectSummary } from '@stack/spec';

import type { WebUser } from '../../../lib/session.js';
import { webAuth } from '../../../lib/web-auth.js';
import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../../lib/machine-context.js';
import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
} from '../../../lib/project-presentation.js';

export type ProjectDetailService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getProjectsReadModel' | 'getMemoryReadModel'
>;


export type ProjectDetailView =
  | { kind: 'error' }
  | { kind: 'not-found' }
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
      name: string;
      lifecycle: ProjectSummary['lifecycle'];
      lifecycleLabel: 'Active' | 'Archived';
      presence: 'On this machine' | 'Not on this machine';
      memoryFact: string;
      cliSelector: string;
      technical: { projectId: string };
    };

const memoryFactFor = (
  mode: MemoryReadModel['mode'],
  fileCount: number | null,
): string => {
  if (mode === 'protected') return 'Unavailable — Protected Memory';
  if (mode !== 'standard' || fileCount === null) return 'Not available';
  return `${fileCount} file${fileCount === 1 ? '' : 's'}`;
};

export const loadProjectDetail = async (
  service: ProjectDetailService,
  user: WebUser,
  projectId: string,
  requestedMachine: string | undefined,
): Promise<ProjectDetailView> => {
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

  let projects: ProjectSummary[];
  let memory: MemoryReadModel;
  try {
    const [p, m] = await Promise.all([
      service.getProjectsReadModel(auth),
      service.getMemoryReadModel(auth),
    ]);
    projects = p.projects;
    memory = m;
  } catch {
    return { kind: 'error' };
  }

  const project = projects.find((p) => p.projectId === projectId);
  if (!project) return { kind: 'not-found' };

  const allForSelector = projects.map((p) => ({
    projectId: p.projectId,
    ...(p.name ? { name: p.name } : {}),
  }));

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    name: project.name ?? project.projectId,
    lifecycle: project.lifecycle,
    lifecycleLabel: lifecycleLabel(project.lifecycle),
    presence: presenceLabel(project.presentOn, viewingId),
    memoryFact: memoryFactFor(memory.mode, project.fileCount),
    cliSelector: cliProjectSelector(
      project.projectId,
      project.name,
      allForSelector,
    ),
    technical: { projectId: project.projectId },
  };
};

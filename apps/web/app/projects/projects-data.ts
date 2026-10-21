import type { CloudService } from '@stack/cloud-server';
import type { ProjectSummary } from '@stack/spec';

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
  type MachineOption,
} from '../../lib/machine-context.js';
import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
  projectDisplayName,
} from '../../lib/project-presentation.js';
import type { SidebarCounts } from '../overview/overview-data.js';
import { loadSidebarSummary } from '../../lib/sidebar-summary.js';

export type ProjectsService = Pick<
  CloudService,
  | 'getMachinesReadModel'
  | 'getProjectsReadModel'
  | 'getOverview'
  | 'listUserStacks'
>;

export type ProjectRow = {
  projectId: string;
  name: string;
  lifecycle: ProjectSummary['lifecycle'];
  lifecycleLabel: 'Active' | 'Archived';
  presence: 'On this machine' | 'Not on this machine';
  fileCountLabel: string;
  cliSelector: string;
};

export const STATUS_FILTERS = ['all', 'active', 'archived'] as const;
export type ProjectStatusFilter = (typeof STATUS_FILTERS)[number];

export const filterProjectRows = (
  rows: ProjectRow[],
  status: ProjectStatusFilter,
  query: string,
): ProjectRow[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (status === 'all') return true;
    return r.lifecycle === status;
  });
};

export type ProjectsListView =
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
      rows: ProjectRow[];
      dockCommand: string;
      dockHint: string;
    };

export const loadProjectsList = async (
  service: ProjectsService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<ProjectsListView> => {
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

  let projects: ProjectSummary[];
  try {
    const result = await service.getProjectsReadModel(auth);
    projects = result.projects;
  } catch {
    return { kind: 'error' };
  }

  const allForSelector = projects.map((p) => ({
    projectId: p.projectId,
    ...(p.name ? { name: p.name } : {}),
  }));

  const rows: ProjectRow[] = projects
    .map((p) => ({
      projectId: p.projectId,
      name: projectDisplayName(p, allForSelector),
      lifecycle: p.lifecycle,
      lifecycleLabel: lifecycleLabel(p.lifecycle),
      presence: presenceLabel(p.presentOn, viewingId),
      fileCountLabel:
        p.fileCount === null
          ? 'Unavailable'
          : `${p.fileCount} file${p.fileCount === 1 ? '' : 's'}`,
      cliSelector: cliProjectSelector(p.projectId, p.name, allForSelector),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const activeCount = rows.filter((r) => r.lifecycle === 'active').length;
  const notHereCount = rows.filter(
    (r) => r.presence === 'Not on this machine' && r.lifecycle === 'active',
  ).length;

  const statusSentence =
    rows.length === 0
      ? 'No Projects yet.'
      : notHereCount === 0
        ? `${activeCount} active Project${activeCount === 1 ? '' : 's'}, all on ${displayName(viewing, active)}.`
        : `${activeCount} active Project${activeCount === 1 ? '' : 's'}; ${notHereCount} not on ${displayName(viewing, active)}.`;

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing, active),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    // `.projects` is this page's own authoritative count (`rows.length`, the same list
    // rendered below) — every other badge comes from the one shared loader.
    sidebar: {
      ...(await loadSidebarSummary(service, user, viewingId, active.length)),
      projects: rows.length > 0 ? String(rows.length) : '',
    },
    statusSentence,
    rows,
    // Unified model: `stak push` is what actually syncs discovered Projects to STAK Cloud
    // (staged first via `stak add .`) — not the standalone, Memory-only `stak memory backup`.
    dockCommand: 'stak push',
    dockHint:
      "Finds Projects in this machine's Memory and syncs them to STAK Cloud.",
  };
};

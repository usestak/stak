import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type {
  ActivityItem,
  MachineSummary,
  NeedsAttention,
  OverviewReadModel,
  ProjectSummary,
} from '@stack/spec';

import type { WebUser } from '../../lib/session';

/** The P3 read methods the Overview consumes; injectable so the view model is unit-testable. */
export type OverviewService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getOverview' | 'getProjectsReadModel'
>;

/** The web calls the P3 service as the signed-in session user (identity never from input). */
const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type MachineOption = {
  machineId: string;
  label: string;
  statusLabel: string;
};

export type OverviewSummary = { label: string; value: string; detail: string };

export type OverviewMachineCard = {
  machineId: string;
  name: string;
  platform?: string;
  arch?: string;
  status: string;
  dot: 'ready' | 'attention' | 'neutral';
  seen: string;
  skills: string;
  projects: string;
  memory: string;
  agents: string;
};

export type OverviewView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[] }
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
      backedUp: boolean;
      headline: string;
      detail: string;
      attentionCount: number;
      summaries: {
        skills: OverviewSummary;
        memory: OverviewSummary;
        projects: OverviewSummary;
        machines: OverviewSummary;
      };
      needsAttention: NeedsAttentionView[];
      activity: ActivityView[];
      machineCards: OverviewMachineCard[];
      dockCommand: string;
    };

export type NeedsAttentionView = {
  kind: NeedsAttention['kind'];
  statusLabel: string;
  dot: 'attention' | 'neutral';
  title: string;
  why: string;
  action: string;
};
export type ActivityView = { what: string; detail: string; when: string };
export type SidebarCounts = {
  overview: { n: string; tone: 'attention' | 'neutral' };
  skills: string;
  memory: { n: string; tone: 'ready' | 'neutral' };
  projects: string;
  machines: string;
  stacks: string;
};

const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const machineStatusLabel = (m: MachineSummary): string => {
  if (m.status === 'never-checked-in') return 'Never checked in';
  if (m.status === 'updates-waiting') return 'Updates waiting';
  if (m.status === 'up-to-date')
    return `Up to date · ${relative(m.lastCheckinAt)}`;
  return `Last seen ${relative(m.lastCheckinAt)}`;
};
const machineDot = (m: MachineSummary): 'ready' | 'attention' | 'neutral' =>
  m.status === 'up-to-date'
    ? 'ready'
    : m.status === 'updates-waiting'
      ? 'attention'
      : 'neutral';

const attentionView = (item: NeedsAttention): NeedsAttentionView => {
  switch (item.kind) {
    case 'update-available':
      return {
        kind: item.kind,
        statusLabel: 'Update available',
        dot: 'attention',
        title: item.label,
        why: 'A newer approved version is available to review.',
        action: 'Review the change before approving.',
      };
    case 'project-not-on-machine':
      return {
        kind: item.kind,
        statusLabel: 'Not on this machine',
        dot: 'neutral',
        title: item.label,
        why: 'Its Memory is safe in STAK; no folder here is mapped to it.',
        action: 'Map its folder on this machine to use it here.',
      };
    case 'machine-stale':
      return {
        kind: item.kind,
        statusLabel: 'Needs attention',
        dot: 'attention',
        title: item.label,
        why: "This machine's CLI hasn't talked to STAK in over 30 days.",
        action: 'Open the CLI there, or revoke it in Settings.',
      };
    case 'protected-no-recovery':
      return {
        kind: item.kind,
        statusLabel: 'Needs attention',
        dot: 'attention',
        title: item.label,
        why: 'Protected Memory can only be recovered with a passkey or recovery file.',
        action: 'Add a recovery method in Settings.',
      };
  }
};

const activityView = (item: ActivityItem): ActivityView => ({
  what:
    item.kind === 'memory-backed-up'
      ? 'Memory backed up'
      : 'Machine checked in',
  detail: item.label ?? '',
  when: relative(item.at),
});

const memorySummary = (
  overview: OverviewReadModel,
  projects: ProjectSummary[],
): OverviewSummary => {
  if (!overview.lastBackupAt)
    return {
      label: 'MEMORY',
      value: 'Not backed up yet',
      detail: 'STAK has no backup of your agent Memory yet.',
    };
  const mode = overview.memory.mode;
  if (mode === 'protected')
    // Protected: never per-file counts from ciphertext. Only the safe project count.
    return {
      label: 'MEMORY',
      value: 'Backed up',
      detail: `${projects.length} project${projects.length === 1 ? '' : 's'} known to STAK. Protected: encrypted on your machine.`,
    };
  return {
    label: 'MEMORY',
    value: 'Backed up',
    detail: `Standard: private to your account; STAK's service can read it to deliver it.`,
  };
};

export const loadOverview = async (
  service: OverviewService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<OverviewView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  try {
    machinesModel = await service.getMachinesReadModel(auth);
  } catch {
    return { kind: 'error' };
  }
  const machines = machinesModel.machines;
  if (machines.length === 0) return { kind: 'no-machines' };

  const options: MachineOption[] = machines.map((m) => ({
    machineId: m.machineId,
    label: m.name ?? m.machineId.slice(0, 8),
    statusLabel: machineStatusLabel(m),
  }));

  // URL machine context takes precedence when valid; else a single machine; else ask.
  const requestedValid =
    requestedMachine && machines.some((m) => m.machineId === requestedMachine);
  const viewingId = requestedValid
    ? requestedMachine
    : machines.length === 1
      ? machines[0]?.machineId
      : undefined;
  if (!viewingId) return { kind: 'choose-machine', machines: options };

  let overview: OverviewReadModel;
  let projects: ProjectSummary[];
  try {
    const [o, p] = await Promise.all([
      service.getOverview(auth, viewingId),
      service.getProjectsReadModel(auth),
    ]);
    overview = o;
    projects = p.projects;
  } catch (error) {
    // An unknown/not-owned machine id fails safely as "choose", not a hard error.
    if (
      error instanceof CloudServiceError &&
      error.code === 'machine-not-found'
    )
      return { kind: 'choose-machine', machines: options };
    return { kind: 'error' };
  }

  const viewing = machines.find(
    (m) => m.machineId === viewingId,
  ) as MachineSummary;
  const attentionCount = overview.needsAttention.length;
  const presentHere = projects.filter((p) =>
    p.presentOn.includes(viewingId),
  ).length;
  const viewingName = viewing.name ?? viewingId.slice(0, 8);

  const headline = overview.lastBackupAt
    ? 'Your STAK is backed up.'
    : "Your STAK isn't backed up yet.";
  const attentionClause =
    attentionCount > 0
      ? ` ${attentionCount} thing${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} you.`
      : '';

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: machineStatusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar: {
      overview: {
        n: attentionCount > 0 ? String(attentionCount) : '—',
        tone: attentionCount > 0 ? 'attention' : 'neutral',
      },
      skills: String(overview.skills.total),
      memory: overview.lastBackupAt
        ? { n: 'Backed up', tone: 'ready' }
        : { n: '—', tone: 'neutral' },
      projects: String(overview.projects.total),
      machines: String(overview.machines.total),
      // Stacks count is not part of the Overview aggregate; shown blank until the Stacks phase.
      stacks: '—',
    },
    backedUp: overview.lastBackupAt !== null,
    headline: `${headline}${attentionClause}`,
    detail: `${viewingName} ${overview.lastBackupAt ? `backed up ${relative(overview.lastBackupAt)}` : 'has no backup yet'}. ${overview.machines.updatesWaiting > 0 ? `${overview.machines.updatesWaiting} machine${overview.machines.updatesWaiting === 1 ? ' has' : 's have'} updates waiting.` : 'All machines are current.'}`,
    attentionCount,
    summaries: {
      skills: {
        label: 'SKILLS',
        value: `${overview.skills.total} ready`,
        detail:
          overview.skills.updatesAvailable > 0
            ? `Instructions your agents follow. ${overview.skills.updatesAvailable} update${overview.skills.updatesAvailable === 1 ? '' : 's'} to review.`
            : 'Instructions your agents follow.',
      },
      memory: memorySummary(overview, projects),
      projects: {
        label: 'PROJECTS',
        value: `${presentHere} of ${overview.projects.total} here`,
        detail:
          overview.projects.total - presentHere > 0
            ? `${overview.projects.total - presentHere} not on ${viewingName}. Their Memory is safe.`
            : 'All present on this machine.',
      },
      machines: {
        label: 'MACHINES',
        value: `${overview.machines.total} machine${overview.machines.total === 1 ? '' : 's'}`,
        detail:
          overview.machines.total === 1
            ? `Your STAK lives on ${viewingName} alone.`
            : 'If one is lost, restore on another.',
      },
    },
    needsAttention: overview.needsAttention.map(attentionView),
    activity: overview.recentActivity.map(activityView),
    machineCards: machines.map((m) => ({
      machineId: m.machineId,
      name: m.name ?? m.machineId.slice(0, 8),
      ...(m.platform ? { platform: m.platform } : {}),
      ...(m.arch ? { arch: m.arch } : {}),
      status:
        m.status === 'updates-waiting'
          ? 'Updates waiting'
          : m.status === 'up-to-date'
            ? 'Up to date'
            : m.status === 'never-checked-in'
              ? 'Never checked in'
              : 'Last seen',
      dot: machineDot(m),
      seen:
        m.status === 'never-checked-in'
          ? 'No check-in yet'
          : m.status === 'up-to-date'
            ? `Checked in ${relative(m.lastCheckinAt)}`
            : `Last seen ${relative(m.lastCheckinAt)}`,
      skills: `${m.updatesWaiting.length === 0 ? 'all skills' : `${m.updatesWaiting.length} waiting`}`,
      projects: `${m.projectsPresent} present`,
      memory: m.memoryBackedUp ? 'Memory backed up' : 'Memory not backed up',
      agents: m.agentsDetected.join(' · ') || 'No agents detected',
    })),
    dockCommand: 'stak memory backup',
  };
};

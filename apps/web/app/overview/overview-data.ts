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

const MAX_CARDS = 4;

export type MachineOption = {
  machineId: string;
  name: string;
  secondary: string;
  statusLabel: string;
};

export type OverviewSummary = { label: string; value: string; detail: string };

export type OverviewMachineCard = {
  machineId: string;
  name: string;
  meta: string;
  status: string;
  dot: 'ready' | 'attention' | 'neutral';
  seen: string;
  checkedIn: boolean;
  facts: {
    skills: string;
    projects: string;
    memory: string;
    agents: string;
  } | null;
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

export type OverviewView =
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
      backedUp: boolean;
      checkedIn: boolean;
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
      overflowCount: number;
      machineTotal: number;
      dockCommand: string;
    };

const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const secs = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const displayName = (m: MachineSummary): string => m.name ?? 'Unnamed machine';
const shortId = (id: string) => id.slice(0, 8);
const checkedIn = (m: MachineSummary): boolean => m.lastCheckinAt !== null;

const metaLine = (m: MachineSummary): string => {
  const hw = [m.platform, m.arch].filter(Boolean).join(' · ');
  // Platform/arch arrive at first check-in; before that the short id is the only safe context.
  return hw || `ID ${shortId(m.machineId)}`;
};

const statusLabel = (m: MachineSummary): string => {
  switch (m.status) {
    case 'never-checked-in':
      return 'No check-in yet';
    case 'updates-waiting':
      return 'Updates waiting';
    case 'up-to-date':
      return `Up to date · ${relative(m.lastCheckinAt)}`;
    default:
      return `Last seen ${relative(m.lastCheckinAt)}`;
  }
};
const machineDot = (m: MachineSummary): 'ready' | 'attention' | 'neutral' =>
  m.status === 'up-to-date'
    ? 'ready'
    : m.status === 'updates-waiting'
      ? 'attention'
      : 'neutral';

const option = (m: MachineSummary): MachineOption => ({
  machineId: m.machineId,
  name: displayName(m),
  secondary: `${metaLine(m)} · ${statusLabel(m)}`,
  statusLabel: statusLabel(m),
});

/** Overview order: attention first (updates waiting), then most recently checked in, then
 *  checked-in machines by recency, then never-checked-in last. */
const sortForOverview = (a: MachineSummary, b: MachineSummary): number => {
  const rank = (m: MachineSummary) =>
    m.status === 'updates-waiting'
      ? 0
      : m.status === 'never-checked-in'
        ? 3
        : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return (b.lastCheckinAt ?? '').localeCompare(a.lastCheckinAt ?? '');
};

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
  projectCount: number,
): OverviewSummary => {
  if (!overview.lastBackupAt)
    return {
      label: 'MEMORY',
      value: 'Not backed up yet',
      detail: 'STAK has no backup of your agent Memory yet.',
    };
  if (overview.memory.mode === 'protected')
    return {
      label: 'MEMORY',
      value: 'Backed up',
      detail: `${projectCount} project${projectCount === 1 ? '' : 's'} known to STAK. Protected: encrypted on your machine.`,
    };
  return {
    label: 'MEMORY',
    value: 'Backed up',
    detail: `Standard: private to your account; STAK's service can read it to deliver it.`,
  };
};

const machineCard = (m: MachineSummary): OverviewMachineCard => {
  const base = {
    machineId: m.machineId,
    name: displayName(m),
    meta: metaLine(m),
    status: statusLabel(m),
    dot: machineDot(m),
  };
  if (!checkedIn(m))
    // Unknown looks unknown — one coherent empty state, never measured-looking zeros.
    return { ...base, seen: '', checkedIn: false, facts: null };
  return {
    ...base,
    seen:
      m.status === 'up-to-date'
        ? `Checked in ${relative(m.lastCheckinAt)}`
        : `Last seen ${relative(m.lastCheckinAt)}`,
    checkedIn: true,
    facts: {
      skills:
        m.updatesWaiting.length === 0
          ? 'All skills at approved version'
          : `${m.updatesWaiting.length} update${m.updatesWaiting.length === 1 ? '' : 's'} waiting`,
      projects: `${m.projectsPresent} project${m.projectsPresent === 1 ? '' : 's'} present`,
      memory: m.memoryBackedUp ? 'Memory backed up' : 'Memory not backed up',
      agents: m.agentsDetected.join(' · ') || 'No agents detected',
    },
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
  // Revoked machines are audit records — never a selectable viewing context, never counted.
  const active = machinesModel.machines.filter((m) => !m.revoked);
  if (active.length === 0) return { kind: 'no-machines' };

  const ordered = [...active].sort(sortForOverview);
  const options = ordered.map(option);
  const anyCheckedIn = active.some(checkedIn);

  const requestedValid =
    requestedMachine && active.some((m) => m.machineId === requestedMachine);
  const viewingId = requestedValid
    ? requestedMachine
    : active.length === 1
      ? active[0]?.machineId
      : undefined;
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

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
    if (
      error instanceof CloudServiceError &&
      error.code === 'machine-not-found'
    )
      return { kind: 'choose-machine', machines: options, anyCheckedIn };
    return { kind: 'error' };
  }

  const viewing = active.find(
    (m) => m.machineId === viewingId,
  ) as MachineSummary;
  const viewingName = displayName(viewing);
  const isCheckedIn = checkedIn(viewing);
  const attentionCount = overview.needsAttention.length;
  const presentHere = projects.filter((p) =>
    p.presentOn.includes(viewingId),
  ).length;
  const projectTotal = overview.projects.total;
  const skillTotal = overview.skills.total;
  const readyCount = Math.max(
    0,
    skillTotal - overview.skills.paused - viewing.updatesWaiting.length,
  );
  const allCurrent = active.every((m) => m.status === 'up-to-date');
  const updatesWaitingMachines = active.filter(
    (m) => m.status === 'updates-waiting',
  ).length;

  // Status sentence — account-level backup fact + a truthful machine/fleet clause.
  const headline = `${overview.lastBackupAt ? 'Your STAK is backed up.' : "Your STAK isn't backed up yet."}${attentionCount > 0 ? ` ${attentionCount} thing${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} you.` : ''}`;
  const backupClause = overview.lastBackupAt
    ? `Latest Memory backup ${relative(overview.lastBackupAt)}.`
    : 'No Memory backup yet.';
  const machineClause = !isCheckedIn
    ? `${viewingName} hasn't checked in yet.`
    : viewing.status === 'updates-waiting'
      ? `${viewingName} has updates waiting.`
      : viewing.status === 'up-to-date'
        ? `${viewingName} is up to date.`
        : `${viewingName} last checked in ${relative(viewing.lastCheckinAt)}.`;
  const fleetClause = allCurrent
    ? ' All machines are current.'
    : updatesWaitingMachines > 0
      ? ` ${updatesWaitingMachines} machine${updatesWaitingMachines === 1 ? '' : 's'} ${updatesWaitingMachines === 1 ? 'has' : 'have'} updates waiting.`
      : '';

  const cards = ordered.slice(0, MAX_CARDS).map(machineCard);

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
      overview:
        attentionCount > 0
          ? { n: String(attentionCount), tone: 'attention' }
          : { n: '', tone: 'neutral' },
      skills: String(skillTotal),
      memory: overview.lastBackupAt
        ? { n: 'Backed up', tone: 'ready' }
        : { n: '', tone: 'neutral' },
      projects: projectTotal > 0 ? String(projectTotal) : '',
      machines: String(active.length),
      stacks: '',
    },
    backedUp: overview.lastBackupAt !== null,
    checkedIn: isCheckedIn,
    headline,
    detail: `${backupClause} ${machineClause}${fleetClause}`,
    attentionCount,
    summaries: {
      skills: isCheckedIn
        ? {
            label: 'SKILLS',
            value: `${readyCount} ready`,
            detail:
              overview.skills.updatesAvailable > 0
                ? `Instructions your agents follow. ${overview.skills.updatesAvailable} update${overview.skills.updatesAvailable === 1 ? '' : 's'} to review.`
                : 'Instructions your agents follow.',
          }
        : {
            label: 'SKILLS',
            value: `${skillTotal} skill${skillTotal === 1 ? '' : 's'} in STAK`,
            detail: "This machine hasn't reported which are installed yet.",
          },
      memory: memorySummary(overview, projectTotal),
      projects:
        projectTotal === 0
          ? {
              label: 'PROJECTS',
              value: 'No projects yet',
              detail:
                'Projects appear once an agent writes Memory and you back it up.',
            }
          : isCheckedIn
            ? {
                label: 'PROJECTS',
                value: `${presentHere} of ${projectTotal} here`,
                detail:
                  projectTotal - presentHere > 0
                    ? `${projectTotal - presentHere} not on ${viewingName}. Their Memory is safe.`
                    : 'All present on this machine.',
              }
            : {
                label: 'PROJECTS',
                value: `${projectTotal} project${projectTotal === 1 ? '' : 's'}`,
                detail: "This machine hasn't reported which are here yet.",
              },
      machines: {
        label: 'MACHINES',
        value: `${active.length} machine${active.length === 1 ? '' : 's'}`,
        detail:
          active.length === 1
            ? `Your STAK lives on ${viewingName} alone.`
            : 'If one is lost, restore on another.',
      },
    },
    needsAttention: overview.needsAttention.map(attentionView),
    activity: overview.recentActivity.map(activityView),
    machineCards: cards,
    overflowCount: Math.max(0, active.length - cards.length),
    machineTotal: active.length,
    dockCommand: 'stak memory backup',
  };
};

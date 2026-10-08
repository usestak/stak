import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  MemoryReadModel,
  ProjectSummary,
} from '@stack/spec';

import {
  loadProjectDetail,
  type ProjectDetailService,
} from './project-detail-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 1,
  ...over,
});

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'prj_abc',
  name: 'stak',
  lifecycle: 'active',
  presentOn: [A1],
  fileCount: 4,
  lastBackupAt: null,
  ...over,
});

const memoryModel = (over: Partial<MemoryReadModel> = {}): MemoryReadModel => ({
  mode: 'standard',
  latestBackupAt: nowIso(60 * 24),
  backups: [],
  recoveryMethods: [],
  hasRecoveryMethod: false,
  perProject: [{ projectId: 'prj_abc', fileCount: 4 }],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
  memory?: MemoryReadModel;
  throwMachines?: boolean;
}): ProjectDetailService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [project()] }),
  getMemoryReadModel: async () => opts.memory ?? memoryModel(),
});

const ready = (view: Awaited<ReturnType<typeof loadProjectDetail>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadProjectDetail', () => {
  it('returns not-found for an unknown projectId', async () => {
    const view = await loadProjectDetail(service({}), USER, 'prj_missing', A1);
    expect(view.kind).toBe('not-found');
  });

  it('returns not-found for a Project not owned by this account (never 500s)', async () => {
    const view = await loadProjectDetail(
      service({ projects: [project({ projectId: 'prj_other' })] }),
      USER,
      'prj_abc',
      A1,
    );
    expect(view.kind).toBe('not-found');
  });

  it('returns error when machines fail to load', async () => {
    const view = await loadProjectDetail(
      service({ throwMachines: true }),
      USER,
      'prj_abc',
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('renders identity, lifecycle, and presence for a known Project', async () => {
    const view = ready(
      await loadProjectDetail(service({}), USER, 'prj_abc', A1),
    );
    expect(view.name).toBe('stak');
    expect(view.lifecycleLabel).toBe('Active');
    expect(view.presence).toBe('On this machine');
    expect(view.technical.projectId).toBe('prj_abc');
  });

  it('shows Standard Memory file count for this one Project', async () => {
    const view = ready(
      await loadProjectDetail(
        service({ memory: memoryModel({ mode: 'standard', perProject: [{ projectId: 'prj_abc', fileCount: 9 }] }) }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.memoryFact).toBe('9 files');
  });

  it('never fabricates a Protected per-project file count', async () => {
    const view = ready(
      await loadProjectDetail(
        service({ memory: memoryModel({ mode: 'protected', perProject: null }) }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.memoryFact).toBe('Unavailable — Protected Memory');
  });

  it('computes the same unique-else-id CLI selector as the list page', async () => {
    const view = ready(
      await loadProjectDetail(
        service({
          projects: [
            project({ projectId: 'prj_abc', name: 'api' }),
            project({ projectId: 'prj_other', name: 'api' }),
          ],
        }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.cliSelector).toBe('prj_abc');
  });
});

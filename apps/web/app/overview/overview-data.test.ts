import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  OverviewReadModel,
  ProjectsReadModel,
} from '@stack/spec';

import { loadOverview, type OverviewService } from './overview-data.js';

const USER = { id: 'user-1' };
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: '00000000-0000-4000-8000-0000000000a1',
  name: 'Atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: ['Claude Code', 'Codex'],
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 7,
  ...over,
});

const overview = (
  over: Partial<OverviewReadModel> = {},
): OverviewReadModel => ({
  viewingMachineId: '00000000-0000-4000-8000-0000000000a1',
  lastBackupAt: nowIso(12),
  skills: { total: 31, paused: 0, updatesAvailable: 2 },
  memory: { mode: 'standard', hasRecoveryMethod: true },
  projects: { total: 9, archived: 0 },
  machines: { total: 1, updatesWaiting: 0 },
  needsAttention: [],
  recentActivity: [
    { kind: 'memory-backed-up', at: nowIso(12), label: 'Memory backup #3' },
    { kind: 'machine-checked-in', at: nowIso(12), label: 'Atlas checked in' },
  ],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  overview?: OverviewReadModel;
  projects?: ProjectsReadModel['projects'];
  throwMachines?: boolean;
  throwOverview?: boolean;
}): OverviewService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getOverview: async () => {
    if (opts.throwOverview) throw new Error('offline');
    return opts.overview ?? overview();
  },
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [] }),
});

const BANNED = [
  'In sync',
  'Online',
  'Offline',
  'Outdated',
  'Lost',
  'Broken',
  'Unsafe',
  'Synced',
  'Only you can read',
];

describe('loadOverview — machine context (P4 §4)', () => {
  it('uses a valid ?machine and auto-selects when a single machine exists', async () => {
    const view = await loadOverview(
      service({}),
      USER,
      '00000000-0000-4000-8000-0000000000a1',
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready')
      expect(view.viewing.machineId).toBe(
        '00000000-0000-4000-8000-0000000000a1',
      );
  });

  it('a not-owned / invalid ?machine with multiple machines asks the user to choose', async () => {
    const m2 = machine({
      machineId: '00000000-0000-4000-8000-0000000000b2',
      name: 'Studio',
    });
    const view = await loadOverview(
      service({ machines: [machine(), m2] }),
      USER,
      'not-a-real-machine',
    );
    expect(view.kind).toBe('choose-machine');
  });

  it('no machines at all → no-machines (empty account)', async () => {
    const view = await loadOverview(service({ machines: [] }), USER, undefined);
    expect(view.kind).toBe('no-machines');
  });

  it('a machines fetch failure → error (not a data change)', async () => {
    const view = await loadOverview(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });
});

describe('loadOverview — status sentence + summaries (P4 §7/§8)', () => {
  it('backed up and nothing needed', async () => {
    const view = await loadOverview(service({}), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.headline).toBe('Your STAK is backed up.');
    expect(view.summaries.skills.value).toBe('31 ready');
    expect(view.summaries.skills.detail).toContain('2 updates to review');
  });

  it('backed up with N things needing the user', async () => {
    const view = await loadOverview(
      service({
        overview: overview({
          needsAttention: [
            {
              kind: 'update-available',
              label: 'Update available for test-first',
              ref: 'skill_x',
            },
            {
              kind: 'project-not-on-machine',
              label: 'mobile-app is not on this machine',
              ref: 'prj_x',
            },
          ],
        }),
      }),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.headline).toBe('Your STAK is backed up. 2 things need you.');
    expect(view.needsAttention).toHaveLength(2);
    expect(view.needsAttention[0]?.statusLabel).toBe('Update available');
    expect(view.needsAttention[1]?.statusLabel).toBe('Not on this machine');
  });

  it('not backed up yet', async () => {
    const view = await loadOverview(
      service({ overview: overview({ lastBackupAt: null }) }),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.headline).toBe("Your STAK isn't backed up yet.");
    expect(view.summaries.memory.value).toBe('Not backed up yet');
  });
});

describe('loadOverview — Standard vs Protected Memory (P4 §15)', () => {
  it('Protected shows safe project count, never a per-file count from ciphertext', async () => {
    const view = await loadOverview(
      service({
        overview: overview({
          memory: { mode: 'protected', hasRecoveryMethod: true },
        }),
        projects: [
          {
            projectId: 'prj_a',
            lifecycle: 'active',
            presentOn: [],
            fileCount: null,
            lastBackupAt: null,
          },
          {
            projectId: 'prj_b',
            lifecycle: 'active',
            presentOn: [],
            fileCount: null,
            lastBackupAt: null,
          },
        ],
      }),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.summaries.memory.detail).toContain('encrypted on your machine');
    expect(view.summaries.memory.detail).toContain('2 projects known to STAK');
    expect(view.summaries.memory.detail).not.toMatch(/\bfiles?\b/);
  });

  it('Standard copy never claims "only you can read it"', async () => {
    const view = await loadOverview(service({}), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.summaries.memory.detail.toLowerCase()).not.toContain(
      'only you',
    );
    expect(view.summaries.memory.detail).toContain('private to your account');
  });
});

describe('loadOverview — machine cards + frozen language (P4 §11/LANGUAGE)', () => {
  const buildWith = (m: MachineSummary) =>
    loadOverview(
      service({ machines: [m], overview: overview() }),
      USER,
      m.machineId,
    );

  it('"Up to date" always appears with a check-in time; never Online/Offline', async () => {
    const view = await buildWith(
      machine({ status: 'up-to-date', lastCheckinAt: nowIso(12) }),
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    const card = view.machineCards[0];
    expect(card?.status).toBe('Up to date');
    expect(card?.seen).toMatch(/Checked in .* ago/);
    expect(JSON.stringify(view)).not.toMatch(/Online|Offline/);
  });

  it('Updates waiting and never-checked-in render truthfully', async () => {
    const updating = await buildWith(
      machine({ status: 'updates-waiting', updatesWaiting: ['skill_x'] }),
    );
    if (updating.kind !== 'ready') throw new Error('ready');
    expect(updating.machineCards[0]?.status).toBe('Updates waiting');

    const fresh = await buildWith(
      machine({ status: 'never-checked-in', lastCheckinAt: null }),
    );
    if (fresh.kind !== 'ready') throw new Error('ready');
    expect(fresh.machineCards[0]?.status).toBe('Never checked in');
    expect(fresh.machineCards[0]?.seen).toBe('No check-in yet');
  });

  it('no banned normal-state words anywhere in the view model', async () => {
    const view = await loadOverview(
      service({
        overview: overview({
          needsAttention: [
            {
              kind: 'protected-no-recovery',
              label: 'Protected Memory has no recovery method',
            },
          ],
          memory: { mode: 'protected', hasRecoveryMethod: false },
        }),
      }),
      USER,
      undefined,
    );
    const serialized = JSON.stringify(view);
    for (const word of BANNED) expect(serialized).not.toContain(word);
  });
});

describe('loadOverview — privacy (P4 §PRIVACY)', () => {
  it('renders no filesystem paths, tokens, or secrets', async () => {
    const view = await loadOverview(
      service({
        projects: [
          {
            projectId: 'prj_a',
            lifecycle: 'active',
            presentOn: ['00000000-0000-4000-8000-0000000000a1'],
            fileCount: 3,
            lastBackupAt: null,
          },
        ],
      }),
      USER,
      '00000000-0000-4000-8000-0000000000a1',
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/\/Users\/|[A-Za-z]:\\\\|~\//);
    expect(serialized).not.toMatch(
      /token|secret|bearer|authorization|\.stackkey/i,
    );
  });
});

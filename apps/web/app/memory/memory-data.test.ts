import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  MemoryReadModel,
  ProjectsReadModel,
} from '@stack/spec';

import { loadMemoryView, type MemoryService } from './memory-data.js';

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
  projectsPresent: 2,
  ...over,
});

const memoryModel = (over: Partial<MemoryReadModel> = {}): MemoryReadModel => ({
  mode: 'standard',
  latestBackupAt: nowIso(60 * 24),
  backups: [
    { generation: 6, mode: 'standard', createdAt: nowIso(60 * 24) },
    { generation: 5, mode: 'standard', createdAt: nowIso(60 * 24 * 8) },
  ],
  recoveryMethods: [],
  hasRecoveryMethod: false,
  perProject: [{ projectId: 'prj_abc', fileCount: 12 }],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  memory?: MemoryReadModel;
  projects?: ProjectsReadModel['projects'];
  throwMachines?: boolean;
  throwMemory?: boolean;
}): MemoryService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getMemoryReadModel: async () => {
    if (opts.throwMemory) throw new Error('offline');
    return opts.memory ?? memoryModel();
  },
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [] }),
});

const ready = (view: Awaited<ReturnType<typeof loadMemoryView>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadMemoryView', () => {
  it('returns error when getMachinesReadModel throws', async () => {
    const view = await loadMemoryView(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines when every machine is revoked', async () => {
    const view = await loadMemoryView(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('auto-selects a single active machine', async () => {
    const view = await loadMemoryView(service({}), USER, undefined);
    expect(ready(view).viewing.machineId).toBe(A1);
  });

  it('asks the caller to choose with 2+ active machines and no valid ?machine=', async () => {
    const view = await loadMemoryView(
      service({
        machines: [
          machine({ machineId: A1 }),
          machine({ machineId: '00000000-0000-4000-8000-0000000000b2' }),
        ],
      }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('choose-machine');
  });

  it('reports Not backed up yet when latestBackupAt is null', async () => {
    const view = ready(
      await loadMemoryView(
        service({ memory: memoryModel({ latestBackupAt: null, backups: [] }) }),
        USER,
        A1,
      ),
    );
    expect(view.statusSentence).toMatch(/not backed up yet/i);
    expect(view.backedUp).toBe(false);
  });

  it('flags a machine-level gap when the selected machine is checked in but memoryBackedUp is false', async () => {
    const view = ready(
      await loadMemoryView(
        service({ machines: [machine({ memoryBackedUp: false })] }),
        USER,
        A1,
      ),
    );
    expect(view.machineGap).toBe(true);
    expect(view.machineSentence).toMatch(/dell/i);
  });

  it('a recovered backup with partial project coverage is NOT described as "not backed up" — the exact live Machine-B scenario', async () => {
    // Machine B: successfully recovered the Cloud backup (so its local manifest matches —
    // memoryBackedUp/machineGap is correctly false), but only 1 of 9 recovered projects is
    // mapped on this machine. Dimension B (local backup freshness) and dimension C (how much
    // of that Memory is available HERE) must read as two separate, truthful facts.
    const projects = [
      {
        projectId: 'prj_1',
        lifecycle: 'active' as const,
        presentOn: [A1],
        fileCount: 1,
        lastBackupAt: nowIso(60),
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        projectId: `prj_not_here_${i}`,
        lifecycle: 'active' as const,
        presentOn: [],
        fileCount: 3,
        lastBackupAt: nowIso(60),
      })),
    ];
    const view = ready(
      await loadMemoryView(
        service({
          machines: [machine({ memoryBackedUp: true })],
          projects,
        }),
        USER,
        A1,
      ),
    );
    expect(view.machineGap).toBe(false);
    expect(view.machineSentence).not.toMatch(/isn.?t backed up/i);
    expect(view.coverageSentence).toMatch(/1 of 9/);
    expect(view.coverageSentence).not.toMatch(/not backed up/i);
  });

  it('coverage clause is absent when every project is present, or when the machine has a genuine local gap', async () => {
    const fullCoverage = ready(
      await loadMemoryView(
        service({
          machines: [machine({ memoryBackedUp: true })],
          projects: [
            {
              projectId: 'prj_1',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: 1,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(fullCoverage.coverageSentence).toBeNull();

    const genuineGap = ready(
      await loadMemoryView(
        service({
          machines: [machine({ memoryBackedUp: false })],
          projects: [
            {
              projectId: 'prj_1',
              lifecycle: 'active',
              presentOn: [],
              fileCount: 1,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    // A genuine local gap (B) is reported as its own fact — coverage (C) doesn't also fire
    // on top of it, so the two never blur into one confusing sentence.
    expect(genuineGap.machineGap).toBe(true);
    expect(genuineGap.coverageSentence).toBeNull();
  });

  it('describes a stale-but-valid machine observation as tied to its last check-in, never as live state', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          machines: [
            machine({
              memoryBackedUp: false,
              lastCheckinAt: nowIso(60 * 24 * 2),
            }),
          ],
          memory: memoryModel({ latestBackupAt: nowIso(60 * 24 * 7) }),
        }),
        USER,
        A1,
      ),
    );
    expect(view.machineSentence).toMatch(/last check-in/i);
    expect(view.machineSentence).toMatch(/dell/i);
    expect(view.machineSentence).not.toMatch(
      /\bhas\b.*changes.*aren'?t backed up/i,
    );
  });

  it('describes a checked-in machine with no gap as up to date at its last check-in', async () => {
    const view = ready(await loadMemoryView(service({}), USER, A1));
    expect(view.machineSentence).toMatch(/up to date at its last check-in/i);
  });

  it('keeps statusSentence account-level only, never naming the machine', async () => {
    const view = ready(
      await loadMemoryView(
        service({ machines: [machine({ memoryBackedUp: false })] }),
        USER,
        A1,
      ),
    );
    expect(view.statusSentence).not.toMatch(/dell/i);
  });

  it('never flags a machine gap when the machine has not checked in', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          machines: [
            machine({
              memoryBackedUp: false,
              lastCheckinAt: null,
              status: 'never-checked-in',
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.machineGap).toBe(false);
  });

  it('never claims a never-checked-in machine is Up to date', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          machines: [
            machine({
              memoryBackedUp: false,
              lastCheckinAt: null,
              status: 'never-checked-in',
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.viewingCheckedIn).toBe(false);
  });

  it('marks viewingCheckedIn true for a machine that has checked in', async () => {
    const view = ready(await loadMemoryView(service({}), USER, A1));
    expect(view.viewingCheckedIn).toBe(true);
  });

  it('exposes Standard perProject rows joined with known project names', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({
            perProject: [{ projectId: 'prj_abc', fileCount: 12 }],
          }),
          projects: [
            {
              projectId: 'prj_abc',
              name: 'stak',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: 12,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.mode).toBe('standard');
    expect(view.perProject).toEqual([
      { projectId: 'prj_abc', name: 'stak', fileCount: 12 },
    ]);
  });

  it('forces perProject null for Protected even if the server somehow returned rows', async () => {
    // Defensive: the server contract already guarantees null for Protected, but the view model
    // must never render a Protected per-project table under any circumstance.
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({ mode: 'protected', perProject: null }),
          projects: [
            {
              projectId: 'prj_abc',
              name: 'stak',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: null,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.mode).toBe('protected');
    expect(view.perProject).toBeNull();
    expect(view.protectedProjectsKnownCount).toBe(1);
  });

  it('surfaces needsRecoveryMethod when Protected has no recovery method', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({
            mode: 'protected',
            perProject: null,
            hasRecoveryMethod: false,
          }),
        }),
        USER,
        A1,
      ),
    );
    expect(view.needsRecoveryMethod).toBe(true);
  });

  it('never surfaces needsRecoveryMethod for Standard', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({ mode: 'standard', hasRecoveryMethod: false }),
        }),
        USER,
        A1,
      ),
    );
    expect(view.needsRecoveryMethod).toBe(false);
  });

  it('returns backup history newest-first with Standard/Protected tags', async () => {
    const view = ready(await loadMemoryView(service({}), USER, A1));
    expect(view.history[0]).toMatchObject({ generation: 6, mode: 'standard' });
    expect(view.history[1]).toMatchObject({ generation: 5, mode: 'standard' });
  });

  it('returns an empty history list honestly when there are no backups', async () => {
    const view = ready(
      await loadMemoryView(
        service({ memory: memoryModel({ backups: [], latestBackupAt: null }) }),
        USER,
        A1,
      ),
    );
    expect(view.history).toEqual([]);
  });

  it('returns error when getMemoryReadModel throws', async () => {
    const view = await loadMemoryView(service({ throwMemory: true }), USER, A1);
    expect(view.kind).toBe('error');
  });
});

import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  OverviewReadModel,
  ProjectsReadModel,
} from '@stack/spec';

import {
  displayPlatform,
  loadOverview,
  type OverviewService,
} from './overview-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const B2 = '00000000-0000-4000-8000-0000000000b2';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: ['Claude Code', 'Codex'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 7,
  ...over,
});

const neverCheckedIn = (over: Partial<MachineSummary> = {}): MachineSummary =>
  machine({
    machineId: A1,
    name: undefined,
    platform: undefined,
    arch: undefined,
    agentsDetected: [],
    lastCheckinAt: null,
    memoryBackedUp: false,
    status: 'never-checked-in',
    updatesWaiting: [],
    projectsPresent: 0,
    ...over,
  });

const overview = (
  over: Partial<OverviewReadModel> = {},
): OverviewReadModel => ({
  viewingMachineId: A1,
  lastBackupAt: nowIso(60 * 24 * 5),
  skills: { total: 31, paused: 0, updatesAvailable: 2 },
  memory: { mode: 'standard', hasRecoveryMethod: true },
  projects: { total: 9, archived: 0 },
  machines: { total: 1, updatesWaiting: 0 },
  needsAttention: [],
  recentActivity: [
    {
      kind: 'memory-backed-up',
      at: nowIso(60 * 24 * 5),
      label: 'Standard backup',
    },
  ],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  overview?: OverviewReadModel;
  projects?: ProjectsReadModel['projects'];
  throwMachines?: boolean;
  stakCount?: number;
}): OverviewService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getOverview: async () => opts.overview ?? overview(),
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [] }),
  listUserStacks: async () => ({
    stacks: Array.from({ length: opts.stakCount ?? 0 }, (_, i) => ({
      stackId: `stack-${i}`,
      name: `stack-${i}`,
      description: '',
      skillCount: 0,
      updatedAt: null,
      versionNumber: 0,
    })),
  }),
});

const ready = (view: Awaited<ReturnType<typeof loadOverview>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

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

describe('loadOverview — machine context + revoked (P4 §2/§4)', () => {
  it('a valid ?machine is used; a single machine auto-selects', async () => {
    expect(
      ready(await loadOverview(service({}), USER, A1)).viewing.machineId,
    ).toBe(A1);
  });

  it('invalid/not-owned ?machine with multiple machines → choose', async () => {
    const view = await loadOverview(
      service({
        machines: [machine(), machine({ machineId: B2, name: 'Studio' })],
      }),
      USER,
      'nope',
    );
    expect(view.kind).toBe('choose-machine');
  });

  it('no machines → no-machines; machines fetch failure → error', async () => {
    expect(
      (await loadOverview(service({ machines: [] }), USER, undefined)).kind,
    ).toBe('no-machines');
    expect(
      (await loadOverview(service({ throwMachines: true }), USER, undefined))
        .kind,
    ).toBe('error');
  });

  it('a revoked machine is not selectable and not counted', async () => {
    const revoked = machine({
      machineId: B2,
      name: 'OldLaptop',
      revoked: true,
    });
    // Only the revoked machine and one active → active auto-selects; revoked absent from options.
    const view = ready(
      await loadOverview(service({ machines: [machine(), revoked] }), USER, B2),
    );
    // Requested B2 (revoked) is rejected; falls back (two machines → but one active ⇒ auto-select active).
    expect(view.viewing.machineId).toBe(A1);
    expect(view.machines.some((m) => m.machineId === B2)).toBe(false);
    expect(view.sidebar.machines).toBe('1');
  });
});

describe('loadOverview — never-checked-in is UNKNOWN, not zero (P4 §3/§4/§5/§6)', () => {
  const view = async () =>
    ready(
      await loadOverview(
        service({ machines: [neverCheckedIn()], overview: overview() }),
        USER,
        A1,
      ),
    );

  it('skills summary says "N skills in STAK", never "ready"', async () => {
    const v = await view();
    expect(v.summaries.skills.value).toBe('31 skills in STAK');
    expect(v.summaries.skills.value).not.toContain('ready');
    expect(v.summaries.skills.detail).toMatch(/hasn't reported/);
  });

  it('projects summary does not claim "all present" or "0 of 0"', async () => {
    const v = await view();
    expect(v.summaries.projects.value).not.toContain('0 of 0');
    expect(v.summaries.projects.detail).not.toContain('All present');
  });

  it('never claims "All machines are current" when a machine has no check-in', async () => {
    const v = await view();
    expect(v.detail).not.toContain('All machines are current');
    expect(v.detail).toContain("hasn't checked in yet");
  });

  it('does not attribute the backup to the machine; uses account-level wording', async () => {
    const v = await view();
    expect(v.detail).toContain('Latest Memory backup');
    expect(v.detail).not.toMatch(/Atlas backed up|Unnamed machine backed up/);
  });

  it('machine card shows one coherent unknown state (facts null)', async () => {
    const v = await view();
    const card = v.machineCards[0];
    expect(card?.checkedIn).toBe(false);
    expect(card?.facts).toBeNull();
    expect(card?.status).toBe('No check-in yet');
  });

  it('Machines summary says "authorized machines" / "None has reported" when none checked in', async () => {
    const v = await view();
    expect(v.summaries.machines.value).toBe('1 authorized machine');
    expect(v.summaries.machines.detail).toBe(
      'None has reported its STAK state yet.',
    );
    expect(v.summaries.machines.detail).not.toContain('restore on another');
  });

  it('top status sentence never overstates: account backup truth stays separate from machine truth', async () => {
    const v = await view();
    // The headline (account-level) still truthfully says backed up...
    expect(v.headline).toBe('Your STAK is backed up.');
    // ...but the detail (machine-level) does not imply the selected machine's state is known.
    expect(v.detail).toMatch(/^Latest Memory backup/);
    expect(v.detail).toContain("Unnamed machine hasn't checked in yet");
  });

  it('command dock never shows a raw UUID as the target machine name', async () => {
    const v = ready(
      await loadOverview(
        service({ machines: [neverCheckedIn({ machineId: A1 })] }),
        USER,
        A1,
      ),
    );
    expect(v.viewing.name).toBe('Unnamed machine');
    expect(v.viewing.name).not.toMatch(/^[0-9a-f-]{8,}$/i);
  });
});

describe('loadOverview — checked-in truth (P4 §4/§5)', () => {
  it('"K ready" = total − paused − updatesWaiting for a checked-in machine', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [machine({ updatesWaiting: ['s1'] })],
          overview: overview({
            skills: { total: 31, paused: 0, updatesAvailable: 2 },
          }),
        }),
        USER,
        A1,
      ),
    );
    expect(v.summaries.skills.value).toBe('30 ready');
  });

  it('"All machines are current" only when every machine is up to date', async () => {
    const all = ready(
      await loadOverview(
        service({ machines: [machine()], overview: overview() }),
        USER,
        A1,
      ),
    );
    expect(all.detail).toContain('All machines are current');
    const mixed = ready(
      await loadOverview(
        service({
          machines: [
            machine(),
            machine({
              machineId: B2,
              name: 'Studio',
              status: 'updates-waiting',
              updatesWaiting: ['s1'],
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(mixed.detail).not.toContain('All machines are current');
    expect(mixed.detail).toContain('updates waiting');
  });

  it('"Up to date" always carries a check-in time; never Online/Offline', async () => {
    const v = ready(await loadOverview(service({}), USER, A1));
    const card = v.machineCards[0];
    expect(card?.status).toBe('Up to date · 12 min ago');
    expect(card?.seen).toMatch(/Checked in/);
    expect(JSON.stringify(v)).not.toMatch(/Online|Offline/);
  });

  it('a single active machine is described precisely — never implying STAK itself "lives" only there when Cloud Memory backup exists', async () => {
    const v = ready(await loadOverview(service({}), USER, A1));
    expect(v.summaries.machines.detail).toBe(
      'Atlas is your only active machine.',
    );
    expect(v.summaries.machines.detail).not.toMatch(/lives on|alone/i);
  });
});

describe('loadOverview — Memory + projects copy (P4 §7/§15)', () => {
  it('zero projects uses a real empty state', async () => {
    const v = ready(
      await loadOverview(
        service({
          overview: overview({ projects: { total: 0, archived: 0 } }),
        }),
        USER,
        A1,
      ),
    );
    expect(v.summaries.projects.value).toBe('No projects yet');
    // Projects are populated by project discovery/sync during check-in (`stak scan`), not by
    // a Memory backup — the detail copy must not claim otherwise (P5 visual-correction §22A).
    expect(v.summaries.projects.detail).toBe(
      'Projects appear once a machine runs `stak scan` and reports them.',
    );
    expect(v.summaries.projects.detail).not.toMatch(
      /back it up|Memory and you/i,
    );
  });

  it('Protected shows a project count, never a per-file count; Standard never says "only you"', async () => {
    const prot = ready(
      await loadOverview(
        service({
          overview: overview({
            memory: { mode: 'protected', hasRecoveryMethod: true },
            projects: { total: 9, archived: 0 },
          }),
        }),
        USER,
        A1,
      ),
    );
    expect(prot.summaries.memory.detail).toContain('encrypted on your machine');
    expect(prot.summaries.memory.detail).toContain('9 projects known to STAK');
    expect(prot.summaries.memory.detail).not.toMatch(/\bfiles?\b/);
    const std = ready(await loadOverview(service({}), USER, A1));
    expect(std.summaries.memory.detail.toLowerCase()).not.toContain('only you');
  });
});

describe('loadOverview — Memory account-vs-machine truth gap (P4 final cleanup §1)', () => {
  // The DELL case: checked in, skills all fine (status 'checked-in'), but this machine's
  // own memory_backed_up is false even though an account-level Cloud backup exists.
  const dellLike = machine({
    name: 'DELL',
    platform: 'win32',
    arch: 'x64',
    status: 'checked-in',
    memoryBackedUp: false,
    updatesWaiting: [],
  });

  it('headline stays the frozen account-level phrase; detail surfaces the machine gap', async () => {
    const v = ready(
      await loadOverview(service({ machines: [dellLike] }), USER, A1),
    );
    expect(v.headline).toBe('Your STAK is backed up.'); // account-level, frozen, true
    expect(v.detail).toContain(
      "DELL has Memory changes that aren't backed up yet.",
    );
  });

  it('MEMORY summary keeps "Backed up" but the detail distinguishes Cloud vs machine state', async () => {
    const v = ready(
      await loadOverview(service({ machines: [dellLike] }), USER, A1),
    );
    expect(v.summaries.memory.value).toBe('Backed up'); // frozen term, account-level
    expect(v.summaries.memory.detail).toContain('Latest Cloud backup');
    // Fixed wording: the Cloud backup genuinely exists (A) — the machine has a LOCAL gap
    // (B), which is a different fact and must never read as though the Cloud backup itself
    // doesn't exist (the original "DELL's current Memory isn't backed up yet." wording,
    // read next to a MEMORY card that says "Backed up", was self-contradictory).
    expect(v.summaries.memory.detail).toContain(
      'DELL has local Memory changes not yet backed up.',
    );
    // Never implies a direct Cloud-payload comparison that hasn't occurred.
    expect(v.summaries.memory.detail).not.toMatch(
      /isn't in it|does not match generation/i,
    );
  });

  it('the counterpart (memory_backed_up=true) never shows the gap wording', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [
            machine({
              name: 'DELL',
              status: 'up-to-date',
              memoryBackedUp: true,
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(v.detail).not.toContain("aren't backed up yet");
    expect(v.summaries.memory.detail).not.toContain("isn't backed up yet");
  });

  it('MEMORY summary adds a project-coverage clause (dimension C) only when there is no local gap', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [
            machine({
              name: 'DELL',
              status: 'up-to-date',
              memoryBackedUp: true,
            }),
          ],
          overview: overview({ projects: { total: 9, archived: 0 } }),
          projects: [
            {
              projectId: 'prj_1',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: 1,
              lastBackupAt: null,
            },
            ...Array.from({ length: 8 }, (_, i) => ({
              projectId: `prj_x${i}`,
              lifecycle: 'active' as const,
              presentOn: [],
              fileCount: 1,
              lastBackupAt: null,
            })),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(v.summaries.memory.detail).toMatch(/1 of 9 project/);
    expect(v.summaries.memory.detail).not.toMatch(/not backed up/i);
  });

  it('project-not-on-machine attention uses the human display name, not the raw prj_ id', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [machine({ name: 'DELL' })],
          overview: overview({
            needsAttention: [
              {
                kind: 'project-not-on-machine',
                label: 'prj_4vm1k8z8tdq54ftc6j534xqh08 is not on this machine',
                ref: 'prj_4vm1k8z8tdq54ftc6j534xqh08',
              },
            ],
          }),
          projects: [
            {
              projectId: 'prj_4vm1k8z8tdq54ftc6j534xqh08',
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
    expect(v.needsAttention[0]!.title).not.toContain(
      'prj_4vm1k8z8tdq54ftc6j534xqh08',
    );
    expect(v.needsAttention[0]!.title).toContain('Local project');
  });

  it('falls back to the server label when the attention ref cannot be resolved', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [machine({ name: 'DELL' })],
          overview: overview({
            needsAttention: [
              {
                kind: 'project-not-on-machine',
                label: 'mystery-project is not on this machine',
                ref: 'prj_does_not_exist',
              },
            ],
          }),
          projects: [],
        }),
        USER,
        A1,
      ),
    );
    expect(v.needsAttention[0]!.title).toBe(
      'mystery-project is not on this machine',
    );
  });

  it('does not create a new Needs-attention kind for the memory gap', async () => {
    const v = ready(
      await loadOverview(service({ machines: [dellLike] }), USER, A1),
    );
    const kinds = new Set(v.needsAttention.map((n) => n.kind));
    for (const k of kinds)
      expect([
        'update-available',
        'project-not-on-machine',
        'machine-stale',
        'protected-no-recovery',
      ]).toContain(k);
  });
});

describe('displayPlatform (P4 final cleanup §2)', () => {
  it('maps known platform identifiers to human-facing labels', () => {
    expect(displayPlatform('win32')).toBe('Windows');
    expect(displayPlatform('darwin')).toBe('macOS');
    expect(displayPlatform('linux')).toBe('Linux');
  });

  it('passes through an unknown platform unchanged and returns undefined for none', () => {
    expect(displayPlatform('freebsd')).toBe('freebsd');
    expect(displayPlatform(undefined)).toBeUndefined();
  });

  it('renders "Windows · x64" on machine cards and the selector, not "win32"', async () => {
    const v = ready(
      await loadOverview(
        service({
          machines: [machine({ name: 'DELL', platform: 'win32', arch: 'x64' })],
        }),
        USER,
        A1,
      ),
    );
    expect(v.machineCards[0]?.meta).toBe('Windows · x64');
    expect(v.machineCards[0]?.meta).not.toContain('win32');
    expect(v.machines[0]?.secondary).toContain('Windows · x64');
  });
});

describe('loadOverview — bounded machine list (P4 §12)', () => {
  it('caps at 4 cards, reports overflow + total, attention first', async () => {
    const machines = [
      machine({ machineId: A1, name: 'Atlas', status: 'up-to-date' }),
      machine({
        machineId: B2,
        name: 'Studio',
        status: 'updates-waiting',
        updatesWaiting: ['s1'],
      }),
      ...Array.from({ length: 4 }, (_, i) =>
        machine({
          machineId: `00000000-0000-4000-8000-00000000c${i}00`,
          name: `M${i}`,
          status: 'up-to-date',
          lastCheckinAt: nowIso(100 + i),
        }),
      ),
    ];
    const v = ready(await loadOverview(service({ machines }), USER, A1));
    expect(v.machineCards).toHaveLength(4);
    expect(v.overflowCount).toBe(2);
    expect(v.machineTotal).toBe(6);
    expect(v.machineCards[0]?.name).toBe('Studio'); // updates-waiting sorts first
  });

  it('never-checked-in machines sort by newest firstSeenAt, not online/offline ordering', async () => {
    const older = machine({
      machineId: A1,
      name: 'Old',
      status: 'never-checked-in',
      lastCheckinAt: null,
      firstSeenAt: nowIso(60 * 24 * 10), // 10 days ago
    });
    const newer = machine({
      machineId: B2,
      name: 'New',
      status: 'never-checked-in',
      lastCheckinAt: null,
      firstSeenAt: nowIso(5), // 5 minutes ago
    });
    const v = ready(
      await loadOverview(service({ machines: [older, newer] }), USER, A1),
    );
    expect(v.machineCards.map((c) => c.name)).toEqual(['New', 'Old']);
  });
});

describe('loadOverview — language, activity, privacy (P4 §10/§13/PRIVACY)', () => {
  it('no banned normal-state words anywhere', async () => {
    const v = await loadOverview(
      service({
        overview: overview({
          memory: { mode: 'protected', hasRecoveryMethod: false },
          needsAttention: [
            {
              kind: 'protected-no-recovery',
              label: 'Protected Memory has no recovery method',
            },
          ],
        }),
      }),
      USER,
      A1,
    );
    const serialized = JSON.stringify(v);
    for (const word of BANNED) expect(serialized).not.toContain(word);
  });

  it('caps recent activity (does not dump a long repetitive backup list)', async () => {
    const recentActivity = Array.from({ length: 8 }, (_, i) => ({
      kind: 'memory-backed-up' as const,
      at: nowIso(i * 60),
      label: 'Standard backup',
    }));
    const v = ready(
      await loadOverview(
        service({ overview: overview({ recentActivity }) }),
        USER,
        A1,
      ),
    );
    expect(v.activity.length).toBeLessThanOrEqual(4);
  });

  it('activity renders the provided (mode) label, not a generic number', async () => {
    const v = ready(
      await loadOverview(
        service({
          overview: overview({
            recentActivity: [
              {
                kind: 'memory-backed-up',
                at: nowIso(10),
                label: 'Protected backup',
              },
            ],
          }),
        }),
        USER,
        A1,
      ),
    );
    expect(v.activity[0]).toEqual({
      what: 'Memory backed up',
      detail: 'Protected backup',
      when: '10 min ago',
    });
  });

  it('renders no paths, tokens, or secrets', async () => {
    const v = await loadOverview(
      service({
        projects: [
          {
            projectId: 'prj_a',
            lifecycle: 'active',
            presentOn: [A1],
            fileCount: 3,
            lastBackupAt: null,
          },
        ],
      }),
      USER,
      A1,
    );
    const serialized = JSON.stringify(v);
    expect(serialized).not.toMatch(/\/Users\/|[A-Za-z]:\\\\|~\//);
    expect(serialized).not.toMatch(
      /token|secret|bearer|authorization|\.stackkey/i,
    );
  });
});

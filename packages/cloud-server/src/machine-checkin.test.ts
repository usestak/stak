import { describe, expect, it } from 'vitest';

import type { CloudRequest } from './handler.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  handleCloudRequest,
} from './index.js';
import { deriveMachineState } from './machine-state.js';

const ATLAS = '00000000-0000-4000-8000-0000000000a1';
const STUDIO = '00000000-0000-4000-8000-0000000000b2';

const setup = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  let clock = new Date('2026-10-05T00:00:00.000Z');
  let counter = 0;
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-ticket-secret',
    now: () => clock,
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    sessionTtlMs: 60_000,
  });
  const call = (
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ) => {
    const request: CloudRequest = {
      method,
      path: `/api/v1/${path}`,
      headers: options.token
        ? { authorization: `Bearer ${options.token}` }
        : {},
    };
    if (options.body !== undefined) request.jsonBody = options.body;
    return handleCloudRequest(service, request);
  };
  const signIn = async (userId: string): Promise<string> => {
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const { userCode, deviceSecret } = start.jsonBody as {
      userCode: string;
      deviceSecret: string;
    };
    await service.approveCliAuth({ userCode, profile: { userId } });
    const token = await call('POST', 'cli/auth/token', {
      body: { deviceSecret },
    });
    return (token.jsonBody as { token: string }).token;
  };
  const setClock = (iso: string) => {
    clock = new Date(iso);
  };
  return { repository, service, call, signIn, setClock };
};

describe('machine check-in routes (P1)', () => {
  it('records a check-in and reads it back (presence only)', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    const res = await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'Atlas',
        platform: 'darwin',
        arch: 'arm64',
        agentsDetected: ['claude', 'codex'],
        memoryBackedUp: true,
        skills: [{ skillId: 'review-pr', installedVersion: 'sha256:aaa' }],
        projects: [{ projectId: 'prj_atlas', present: true }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true });

    const list = await call('GET', 'machines', { token });
    const body = list.jsonBody as {
      machines: Array<{
        machineId: string;
        name?: string;
        memoryBackedUp: boolean;
        lastCheckinAt: string | null;
        skills: unknown[];
        projects: Array<{ projectId: string; present: boolean }>;
      }>;
    };
    expect(body.machines).toHaveLength(1);
    const m = body.machines[0];
    expect(m?.machineId).toBe(ATLAS);
    expect(m?.name).toBe('Atlas');
    expect(m?.memoryBackedUp).toBe(true);
    expect(m?.lastCheckinAt).not.toBeNull();
    expect(m?.projects).toEqual([{ projectId: 'prj_atlas', present: true }]);
  });

  it('a check-in response carries no filesystem paths and no Memory content', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        memoryBackedUp: true,
        skills: [{ skillId: 'review-pr', installedVersion: 'sha256:aaa' }],
        projects: [{ projectId: 'prj_atlas', present: true }],
      },
    });
    const list = await call('GET', 'machines', { token });
    const serialized = JSON.stringify(list.jsonBody);
    // No absolute POSIX path, Windows path, or home-relative locator.
    expect(serialized).not.toMatch(/(^|")\/[A-Za-z]/);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain('~/');
    // No Memory manifest/content leaked into the machine read model.
    expect(serialized.toLowerCase()).not.toContain('manifest');
  });

  it('rejects a payload that smuggles an unexpected field (e.g. a path)', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    const res = await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        memoryBackedUp: false,
        skills: [],
        // A path on a project entry must be rejected by the strict schema.
        projects: [
          { projectId: 'prj_x', present: true, path: '/Users/dana/x' },
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  it('check-in requires authentication (401 without a token)', async () => {
    const { call } = setup();
    const res = await call('POST', 'machines/checkin', {
      body: {
        machineId: ATLAS,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    expect(res.status).toBe(401);
    const list = await call('GET', 'machines');
    expect(list.status).toBe(401);
  });

  it('two machines report distinct derived states', async () => {
    const { call, signIn, setClock } = setup();
    const token = await signIn('user-1');
    setClock('2026-10-05T12:00:00.000Z');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        memoryBackedUp: true,
        skills: [{ skillId: 'review-pr', installedVersion: '2.0.0' }],
        projects: [],
      },
    });
    setClock('2026-10-05T09:00:00.000Z');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: STUDIO,
        memoryBackedUp: true,
        skills: [{ skillId: 'review-pr', installedVersion: '1.0.0' }],
        projects: [],
      },
    });
    const list = await call('GET', 'machines', { token });
    type MachineRow = {
      machineId: string;
      lastCheckinAt: string | null;
      memoryBackedUp: boolean;
      skills: { skillId: string; installedVersion: string }[];
    };
    const machines = (list.jsonBody as { machines: MachineRow[] }).machines;
    const approved = [
      { skillId: 'review-pr', approvedVersion: '2.0.0', paused: false },
    ];
    const byId = (id: string): MachineRow => {
      const row = machines.find((m) => m.machineId === id);
      if (!row) throw new Error(`machine ${id} not found`);
      return row;
    };
    const facts = (id: string) => ({
      lastCheckinAt: byId(id).lastCheckinAt,
      memoryBackedUp: byId(id).memoryBackedUp,
      skills: byId(id).skills,
    });
    const atlas = deriveMachineState(facts(ATLAS), approved);
    const studio = deriveMachineState(facts(STUDIO), approved);
    expect(atlas.status).toBe('up-to-date');
    expect(studio.status).toBe('updates-waiting');
    expect(studio.updatesWaiting).toEqual(['review-pr']);
  });
});

describe('deriveMachineState edge cases (P1)', () => {
  const approved = [
    { skillId: 'a', approvedVersion: '2', paused: false },
    { skillId: 'paused-one', approvedVersion: '9', paused: true },
  ];

  it('never checked in → never-checked-in', () => {
    expect(
      deriveMachineState(
        { lastCheckinAt: null, memoryBackedUp: false, skills: [] },
        approved,
      ).status,
    ).toBe('never-checked-in');
  });

  it('paused skills never count toward updates waiting', () => {
    const state = deriveMachineState(
      {
        lastCheckinAt: '2026-10-05T00:00:00.000Z',
        memoryBackedUp: true,
        skills: [{ skillId: 'a', installedVersion: '2' }], // paused-one not installed
      },
      approved,
    );
    expect(state.updatesWaiting).toEqual([]);
    expect(state.status).toBe('up-to-date');
  });

  it('versions match but Memory never backed up → checked-in, not up to date', () => {
    const state = deriveMachineState(
      {
        lastCheckinAt: '2026-10-05T00:00:00.000Z',
        memoryBackedUp: false,
        skills: [{ skillId: 'a', installedVersion: '2' }],
      },
      approved,
    );
    expect(state.upToDate).toBe(false);
    expect(state.status).toBe('checked-in');
  });

  it('a skill the machine never reported counts as waiting', () => {
    const state = deriveMachineState(
      {
        lastCheckinAt: '2026-10-05T00:00:00.000Z',
        memoryBackedUp: true,
        skills: [],
      },
      approved,
    );
    expect(state.status).toBe('updates-waiting');
    expect(state.updatesWaiting).toEqual(['a']);
  });
});

describe('machine friendly-name contract (P4)', () => {
  it('A. null name + first check-in populates the name from the reported hostname', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'atlas-macbook',
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const list = await call('GET', 'machines', { token });
    const machines = (list.jsonBody as { machines: Array<{ name?: string }> })
      .machines;
    expect(machines[0]?.name).toBe('atlas-macbook');
  });

  it('B. an existing friendly name survives a later hostname change', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'atlas-macbook',
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    // The machine's hostname changes (renamed at the OS level) on a later check-in.
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'some-new-hostname',
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    const list = await call('GET', 'machines', { token });
    const machines = (list.jsonBody as { machines: Array<{ name?: string }> })
      .machines;
    expect(machines[0]?.name).toBe('atlas-macbook'); // the original friendly name is kept
  });

  it('C. two machines sharing a reported hostname remain distinct by machine_id', async () => {
    const { call, signIn } = setup();
    const token = await signIn('user-1');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'laptop',
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: STUDIO,
        name: 'laptop',
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const list = await call('GET', 'machines', { token });
    const machines = (
      list.jsonBody as {
        machines: Array<{ machineId: string; name?: string }>;
      }
    ).machines;
    expect(machines).toHaveLength(2);
    expect(machines.find((m) => m.machineId === ATLAS)?.name).toBe('laptop');
    expect(machines.find((m) => m.machineId === STUDIO)?.name).toBe('laptop');
  });

  it('a later upsertMachine (login/push) never wipes the name or resets first_seen_at', async () => {
    const { call, repository, signIn, setClock } = setup();
    const token = await signIn('user-1');
    setClock('2026-10-05T00:00:00.000Z');
    await call('POST', 'machines/checkin', {
      token,
      body: {
        machineId: ATLAS,
        name: 'atlas-macbook',
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const firstList = (await call('GET', 'machines', { token })).jsonBody as {
      machines: Array<{ machineId: string; name?: string }>;
    };
    expect(firstList.machines[0]?.name).toBe('atlas-macbook');
    const firstSeenAt = (await repository.listMachineStates('user-1'))[0]
      ?.firstSeenAt;

    // A later login/push calls upsertMachine directly (never reporting name), which must
    // neither erase the name established by check-in nor reset first_seen_at to "now".
    setClock('2026-10-10T00:00:00.000Z');
    await repository.upsertMachine({
      userId: 'user-1',
      machineId: ATLAS,
      firstSeenAt: '2026-10-10T00:00:00.000Z',
    });

    const secondList = (await call('GET', 'machines', { token })).jsonBody as {
      machines: Array<{ machineId: string; name?: string }>;
    };
    expect(secondList.machines[0]?.name).toBe('atlas-macbook');
    const secondState = await repository.listMachineStates('user-1');
    expect(secondState[0]?.firstSeenAt).toBe(firstSeenAt); // unchanged, not reset to "now"
  });
});

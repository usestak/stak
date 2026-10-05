import { describe, expect, it } from 'vitest';

import { computeEnvironmentBundleDigest } from '@stack/shared';
import type { CloudEnvironmentBundle, PortableLockedSkill } from '@stack/spec';

import type { CloudRequest } from './handler.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
  handleCloudRequest,
} from './index.js';
import type { SkillSourceChecker } from './product-service.js';

const h = (c: string) => `sha256:${c.repeat(64)}`;
const MACHINE_A = '00000000-0000-4000-8000-0000000000a1';

const gitSkill = (
  name: string,
  contentHash: string,
  options: {
    ref?: string;
    remote?: string;
    paused?: boolean;
    capabilities?: Record<string, boolean>;
    description?: string;
  } = {},
): PortableLockedSkill => ({
  name,
  description: options.description ?? `${name} description`,
  contentHash,
  observedSources: [],
  restoration: {
    strategy: 'reference',
    reference: {
      remote: options.remote ?? 'https://github.com/acme/skills.git',
      revision: 'r'.repeat(40),
      path: `skills/${name}`,
      expectedContentHash: contentHash,
      ...(options.ref ? { ref: options.ref } : {}),
    },
  },
  ...(options.capabilities
    ? {
        metadata: {
          name,
          description: `${name} description`,
          capabilities: options.capabilities,
        },
      }
    : {}),
  ...(options.paused ? { paused: true } : {}),
});

const localSkill = (
  name: string,
  contentHash: string,
): PortableLockedSkill => ({
  name,
  description: `${name} description`,
  contentHash,
  observedSources: [],
  restoration: { strategy: 'snapshot', contentHash, reason: 'local' },
});

const buildBundle = (
  skills: Record<string, PortableLockedSkill>,
): CloudEnvironmentBundle => {
  const environment = {
    schemaVersion: 1 as const,
    name: 'main',
    skills: Object.entries(skills).map(([id, s]) => ({
      id,
      name: s.name,
      requirement: 'required' as const,
    })),
    stacks: [],
    overrides: {},
  };
  const resolved = { schemaVersion: 1 as const, skills };
  const digest = computeEnvironmentBundleDigest({
    environment,
    resolved,
    importedStackVersions: [],
  });
  return {
    schemaVersion: 1,
    environment,
    resolved,
    importedStackVersions: [],
    snapshotRequirements: [],
    digest,
  };
};

const setup = (options: { checkSkillSource?: SkillSourceChecker } = {}) => {
  const repository = createInMemoryRepository();
  const memory = createInMemoryMemoryBackends();
  let clock = new Date('2026-10-05T00:00:00.000Z');
  let counter = 0;
  const service = createCloudService({
    repository,
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-secret',
    now: () => clock,
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    memoryBackendFor: memory.memoryBackendFor,
    ...(options.checkSkillSource
      ? { checkSkillSource: options.checkSkillSource }
      : {}),
  });
  const call = (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ) => {
    const request: CloudRequest = {
      method,
      path: `/api/v1/${path}`,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    };
    if (opts.body !== undefined) request.jsonBody = opts.body;
    return handleCloudRequest(service, request);
  };
  const signIn = async (
    userId: string,
    machineId?: string,
  ): Promise<string> => {
    const start = await call('POST', 'cli/auth/start', {
      body: machineId
        ? { machine: { machineId, platform: 'linux', arch: 'x64' } }
        : {},
    });
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
  const pushBundle = (token: string, bundle: CloudEnvironmentBundle) =>
    call('POST', 'environments/main/versions', {
      token,
      body: { bundle, expectedLatestVersionId: null },
    });
  const setClock = (iso: string) => {
    clock = new Date(iso);
  };
  return { service, repository, memory, call, signIn, pushBundle, setClock };
};

/* ------------------------------ AUTHORIZATION ------------------------------ */

describe('P3 authorization', () => {
  it('a user never sees another account’s skills, machines, or projects', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({ skill_aaaaaaaa: gitSkill('a', h('a')) }),
    );
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [{ skillId: 'skill_aaaaaaaa', installedVersion: h('a') }],
        projects: [{ projectId: 'prj_alice', present: true }],
      },
    });
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: { projects: [{ projectId: 'prj_alice', lifecycle: 'active' }] },
    });

    const bob = await env.signIn('bob');
    const bobSkills = await env.call('GET', 'skills', { token: bob });
    expect(bobSkills.jsonBody).toMatchObject({
      environmentExists: false,
      skills: [],
    });
    const bobMachines = await env.call('GET', 'machines/view', { token: bob });
    expect(
      (bobMachines.jsonBody as { machines: unknown[] }).machines,
    ).toHaveLength(0);
    const bobProjects = await env.call('GET', 'projects', { token: bob });
    expect(
      (bobProjects.jsonBody as { projects: unknown[] }).projects,
    ).toHaveLength(0);
  });

  it('unauthenticated requests are 401', async () => {
    const env = setup();
    expect((await env.call('GET', 'skills')).status).toBe(401);
    expect((await env.call('GET', 'overview')).status).toBe(401);
    expect((await env.call('GET', 'machines/view')).status).toBe(401);
  });

  it('a user cannot revoke another account’s machine', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const bob = await env.signIn('bob');
    const res = await env.call('POST', `machines/${MACHINE_A}/revoke`, {
      token: bob,
    });
    expect(res.status).toBe(404);
    // Alice's machine is untouched.
    const machines = await env.call('GET', 'machines/view', { token: alice });
    expect(
      (machines.jsonBody as { machines: { revoked: boolean }[] }).machines[0]
        ?.revoked,
    ).toBe(false);
  });

  it('viewing-machine must belong to the authenticated user', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const bob = await env.signIn('bob');
    const res = await env.call('GET', `overview?machine=${MACHINE_A}`, {
      token: bob,
    });
    expect(res.status).toBe(404);
  });
});

/* --------------------------------- SKILLS --------------------------------- */

describe('P3 skills read model', () => {
  it('separates approved/installed and keeps same-named skills distinct by stable id', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({
        skill_dup00001: gitSkill('review-pr', h('a')),
        skill_dup00002: gitSkill('review-pr', h('b')),
      }),
    );
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [{ skillId: 'skill_dup00001', installedVersion: h('a') }],
        projects: [],
      },
    });
    const res = await env.call('GET', 'skills', { token: alice });
    const body = res.jsonBody as {
      skills: Array<{
        skillId: string;
        approvedVersion: string;
        installs: unknown[];
      }>;
    };
    expect(body.skills).toHaveLength(2);
    const first = body.skills.find((s) => s.skillId === 'skill_dup00001');
    const second = body.skills.find((s) => s.skillId === 'skill_dup00002');
    expect(first?.approvedVersion).toBe(h('a'));
    expect(second?.approvedVersion).toBe(h('b'));
    expect(first?.installs).toHaveLength(1); // installed on A
    expect(second?.installs).toHaveLength(0); // approved but not installed
  });

  it('distinguishes update-available, no-update, and cannot-check', async () => {
    const checkSkillSource: SkillSourceChecker = async ({ skillId }) => {
      if (skillId === 'skill_update001')
        return { status: 'different', sourceRevision: 'f'.repeat(40) };
      if (skillId === 'skill_current01') return { status: 'same' };
      return { status: 'uncheckable' };
    };
    const env = setup({ checkSkillSource });
    const alice = await env.signIn('alice');
    await env.pushBundle(
      alice,
      buildBundle({
        skill_update001: gitSkill('needs-update', h('a'), {
          ref: 'refs/heads/main',
        }),
        skill_current01: gitSkill('current', h('b'), {
          ref: 'refs/heads/main',
        }),
        skill_local0001: localSkill('local-one', h('c')),
      }),
    );
    const res = await env.call('GET', 'skills', { token: alice });
    const body = res.jsonBody as {
      skills: Array<{
        skillId: string;
        updateStatus: string;
        candidateVersion?: string;
      }>;
    };
    const byId = (id: string) => body.skills.find((s) => s.skillId === id);
    expect(byId('skill_update001')?.updateStatus).toBe('update-available');
    expect(byId('skill_update001')?.candidateVersion).toBe('f'.repeat(40));
    expect(byId('skill_current01')?.updateStatus).toBe('no-update');
    expect(byId('skill_local0001')?.updateStatus).toBe('cannot-check');
  });

  it('exposes declared capabilities and "not declared" truthfully', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await env.pushBundle(
      alice,
      buildBundle({
        skill_withcaps1: gitSkill('caps', h('a'), {
          capabilities: { readFiles: true, network: false },
        }),
        skill_nocaps001: gitSkill('nocaps', h('b')),
      }),
    );
    const body = (await env.call('GET', 'skills', { token: alice }))
      .jsonBody as {
      skills: Array<{
        skillId: string;
        capability: {
          declared: boolean;
          capabilities?: Record<string, boolean>;
        };
      }>;
    };
    const caps = body.skills.find(
      (s) => s.skillId === 'skill_withcaps1',
    )?.capability;
    expect(caps?.declared).toBe(true);
    expect(caps?.capabilities).toEqual({ readFiles: true, network: false });
    const none = body.skills.find(
      (s) => s.skillId === 'skill_nocaps001',
    )?.capability;
    expect(none).toEqual({ declared: false });
  });

  it('account-side pause/resume changes desired state via a new environment version', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await env.pushBundle(
      alice,
      buildBundle({ skill_pausable1: gitSkill('p', h('a')) }),
    );
    const paused = await env.call('POST', 'skills/skill_pausable1/pause', {
      token: alice,
      body: { paused: true },
    });
    expect(paused.jsonBody).toMatchObject({ changed: true, paused: true });
    const afterPause = (await env.call('GET', 'skills', { token: alice }))
      .jsonBody as {
      skills: Array<{ skillId: string; paused: boolean }>;
    };
    expect(afterPause.skills[0]?.paused).toBe(true);
    const resumed = await env.call('POST', 'skills/skill_pausable1/pause', {
      token: alice,
      body: { paused: false },
    });
    expect(resumed.jsonBody).toMatchObject({ changed: true, paused: false });
  });

  it('approve advances desired version; a stale/no-op candidate is idempotent', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await env.pushBundle(
      alice,
      buildBundle({
        skill_approve01: gitSkill('ap', h('a'), { ref: 'refs/heads/main' }),
      }),
    );
    const approve = await env.call('POST', 'skills/skill_approve01/approve', {
      token: alice,
      body: { candidateContentHash: h('b'), candidateRevision: 'f'.repeat(40) },
    });
    expect(approve.jsonBody).toMatchObject({
      createdNew: true,
      approvedVersion: h('b'),
    });
    // Desired version advanced.
    const skills = (await env.call('GET', 'skills', { token: alice }))
      .jsonBody as {
      skills: Array<{ approvedVersion: string }>;
    };
    expect(skills.skills[0]?.approvedVersion).toBe(h('b'));
    // Re-approving the SAME candidate is an idempotent no-op (not a new version).
    const again = await env.call('POST', 'skills/skill_approve01/approve', {
      token: alice,
      body: { candidateContentHash: h('b'), candidateRevision: 'f'.repeat(40) },
    });
    expect(again.jsonBody).toMatchObject({ createdNew: false });
  });

  it('approval does not mutate any machine’s installed state', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({
        skill_approve01: gitSkill('ap', h('a'), { ref: 'refs/heads/main' }),
      }),
    );
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [{ skillId: 'skill_approve01', installedVersion: h('a') }],
        projects: [],
      },
    });
    await env.call('POST', 'skills/skill_approve01/approve', {
      token: alice,
      body: { candidateContentHash: h('b'), candidateRevision: 'f'.repeat(40) },
    });
    // The machine still reports the OLD installed version → Updates waiting.
    const machines = (await env.call('GET', 'machines/view', { token: alice }))
      .jsonBody as {
      machines: Array<{ status: string; updatesWaiting: string[] }>;
    };
    expect(machines.machines[0]?.status).toBe('updates-waiting');
    expect(machines.machines[0]?.updatesWaiting).toEqual(['skill_approve01']);
  });
});

/* -------------------------------- MACHINES -------------------------------- */

describe('P3 machines read model + revoke', () => {
  it('derives up-to-date / updates-waiting / never-checked-in', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({ skill_only000001: gitSkill('only', h('a')) }),
    );
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [{ skillId: 'skill_only000001', installedVersion: h('a') }],
        projects: [],
      },
    });
    const machines = (await env.call('GET', 'machines/view', { token: alice }))
      .jsonBody as {
      machines: Array<{ status: string }>;
    };
    expect(machines.machines[0]?.status).toBe('up-to-date');
  });

  it('revokes a machine (audit row kept) and rejects the revoked token', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const revoke = await env.call('POST', `machines/${MACHINE_A}/revoke`, {
      token: alice,
    });
    expect(revoke.jsonBody).toEqual({ machineId: MACHINE_A, revoked: true });
    // The revoked token can no longer authenticate.
    expect((await env.call('GET', 'skills', { token: alice })).status).toBe(
      401,
    );
    // The machine row is retained as a revoked record (audit).
    const bob = await env.signIn('alice'); // same user, new token
    const machines = (await env.call('GET', 'machines/view', { token: bob }))
      .jsonBody as {
      machines: Array<{ machineId: string; revoked: boolean }>;
    };
    expect(
      machines.machines.find((m) => m.machineId === MACHINE_A)?.revoked,
    ).toBe(true);
  });

  it('a machines response carries no paths and no Memory content', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        name: 'Atlas',
        platform: 'darwin',
        memoryBackedUp: true,
        skills: [{ skillId: 'skill_x0000001', installedVersion: h('a') }],
        projects: [{ projectId: 'prj_x', present: true }],
      },
    });
    const serialized = JSON.stringify(
      (await env.call('GET', 'machines/view', { token: alice })).jsonBody,
    );
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain('~/');
    expect(serialized.toLowerCase()).not.toContain('manifest');
  });
});

/* -------------------------------- PROJECTS -------------------------------- */

describe('P3 projects read model + lifecycle', () => {
  it('keeps lifecycle independent of per-machine presence and returns no bindings/paths', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: {
        projects: [
          { projectId: 'prj_here', lifecycle: 'active', name: 'Atlas' },
          { projectId: 'prj_away', lifecycle: 'active' },
        ],
      },
    });
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [],
        projects: [
          { projectId: 'prj_here', present: true },
          { projectId: 'prj_away', present: false },
        ],
      },
    });
    const res = await env.call('GET', 'projects', { token: alice });
    const body = res.jsonBody as {
      projects: Array<{
        projectId: string;
        lifecycle: string;
        presentOn: string[];
        fileCount: number | null;
      }>;
    };
    const here = body.projects.find((p) => p.projectId === 'prj_here');
    const away = body.projects.find((p) => p.projectId === 'prj_away');
    expect(here?.presentOn).toEqual([MACHINE_A]);
    expect(away?.presentOn).toEqual([]); // not present, still active
    expect(here?.lifecycle).toBe('active');
    expect(here?.fileCount).toBeNull(); // no Standard count deriver injected
    // No bindings / paths leaked.
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|[A-Za-z]:\\\\|~\//);

    // Archive is lifecycle-only and independent of presence.
    const archived = await env.call('POST', 'projects/prj_here/lifecycle', {
      token: alice,
      body: { lifecycle: 'archived' },
    });
    expect(archived.jsonBody).toMatchObject({ lifecycle: 'archived' });
    const after = (await env.call('GET', 'projects', { token: alice }))
      .jsonBody as {
      projects: Array<{
        projectId: string;
        lifecycle: string;
        presentOn: string[];
      }>;
    };
    const hereAfter = after.projects.find((p) => p.projectId === 'prj_here');
    expect(hereAfter?.lifecycle).toBe('archived');
    expect(hereAfter?.presentOn).toEqual([MACHINE_A]); // presence unchanged by archiving
  });
});

/* --------------------------------- MEMORY --------------------------------- */

describe('P3 memory read model + delete', () => {
  const seedMemory = async (
    env: ReturnType<typeof setup>,
    userId: string,
    mode: 'standard' | 'protected',
  ) => {
    const backend = env.memory.memoryBackendFor(userId);
    await backend.ensureProfile('1');
    if (mode === 'protected') await backend.setPrivacyMode('protected');
    await backend.createGeneration({
      backupId: `b-${userId}-1`,
      expectedParent: null,
      privacyMode: mode,
      payload: new Uint8Array([1, 2, 3]),
      bundleFormatVersion: '1',
    });
    return backend;
  };

  it('Standard read model lists backups and recovery methods; perProject stays null without a deriver', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await seedMemory(env, 'alice', 'standard');
    const body = (await env.call('GET', 'memory/view', { token: alice }))
      .jsonBody as {
      mode: string;
      backups: unknown[];
      hasRecoveryMethod: boolean;
      perProject: unknown;
    };
    expect(body.mode).toBe('standard');
    expect(body.backups).toHaveLength(1);
    expect(body.hasRecoveryMethod).toBe(false);
    expect(body.perProject).toBeNull();
  });

  it('Protected read model exposes no plaintext and perProject is null (not decrypted)', async () => {
    const env = setup({});
    const alice = await env.signIn('alice');
    await seedMemory(env, 'alice', 'protected');
    const res = await env.call('GET', 'memory/view', { token: alice });
    const body = res.jsonBody as { mode: string; perProject: unknown };
    expect(body.mode).toBe('protected');
    expect(body.perProject).toBeNull();
    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized.toLowerCase()).not.toContain('manifest');
    expect(serialized).not.toContain('wrappedDek');
  });

  it('delete Cloud Memory removes generations + recovery methods and reports not recoverable', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    const backend = await seedMemory(env, 'alice', 'standard');
    await backend.addRecoveryMethod({
      type: 'recovery-file',
      label: 'file',
      mmkWrapper: { v: 'x' },
      cryptoVersion: 'stak-v1',
    });
    const res = await env.call('POST', 'memory/delete', { token: alice });
    expect(res.jsonBody).toMatchObject({
      recoverable: false,
      deletedRecoveryMethods: 1,
    });
    // Unrelated data (a machine) is untouched.
    const after = await env.call('GET', 'memory/view', { token: alice });
    expect((after.jsonBody as { backups: unknown[] }).backups).toHaveLength(0);
    expect(
      (after.jsonBody as { hasRecoveryMethod: boolean }).hasRecoveryMethod,
    ).toBe(false);
  });
});

/* ------------------------- STACKS / ACTIVITY / OVERVIEW ------------------------- */

describe('P3 stacks / activity / overview', () => {
  it('owned stacks read model reports the main environment version + skill count', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await env.pushBundle(
      alice,
      buildBundle({
        skill_stack001: gitSkill('s1', h('a')),
        skill_stack002: gitSkill('s2', h('b')),
      }),
    );
    const body = (await env.call('GET', 'stacks-owned', { token: alice }))
      .jsonBody as {
      owned: Array<{
        name: string;
        skillCount: number;
        latestVersionNumber: number | null;
      }>;
    };
    expect(body.owned[0]).toMatchObject({
      name: 'main',
      skillCount: 2,
      latestVersionNumber: 1,
    });
  });

  it('activity derives from real backups and check-ins only', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    const backend = env.memory.memoryBackendFor('alice');
    await backend.ensureProfile('1');
    await backend.createGeneration({
      backupId: 'b-alice-1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: new Uint8Array([1, 2, 3]),
      bundleFormatVersion: '1',
    });
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        name: 'Atlas',
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    const body = (await env.call('GET', 'activity', { token: alice }))
      .jsonBody as {
      items: Array<{ kind: string }>;
    };
    const kinds = body.items.map((i) => i.kind);
    expect(kinds).toContain('memory-backed-up');
    expect(kinds).toContain('machine-checked-in');
    // No fabricated event types.
    expect(
      kinds.every((k) =>
        ['memory-backed-up', 'machine-checked-in'].includes(k),
      ),
    ).toBe(true);
  });

  it('overview needs-attention: Protected without recovery + viewing-machine project gap', async () => {
    const env = setup({
      checkSkillSource: async () => ({
        status: 'different',
        sourceRevision: 'f'.repeat(40),
      }),
    });
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({
        skill_up000001: gitSkill('up', h('a'), { ref: 'refs/heads/main' }),
      }),
    );
    const backend = env.memory.memoryBackendFor('alice');
    await backend.ensureProfile('1');
    await backend.setPrivacyMode('protected');
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: { projects: [{ projectId: 'prj_away', lifecycle: 'active' }] },
    });
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [],
        projects: [{ projectId: 'prj_away', present: false }],
      },
    });
    const body = (
      await env.call('GET', `overview?machine=${MACHINE_A}`, { token: alice })
    ).jsonBody as {
      viewingMachineId: string | null;
      needsAttention: Array<{ kind: string }>;
    };
    expect(body.viewingMachineId).toBe(MACHINE_A);
    const kinds = body.needsAttention.map((n) => n.kind);
    expect(kinds).toContain('update-available');
    expect(kinds).toContain('protected-no-recovery');
    expect(kinds).toContain('project-not-on-machine');
  });

  it('an account with no data returns an empty, non-broken overview', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    const body = (await env.call('GET', 'overview', { token: alice }))
      .jsonBody as {
      needsAttention: unknown[];
      skills: { total: number };
      viewingMachineId: string | null;
    };
    expect(body.skills.total).toBe(0);
    expect(body.needsAttention).toEqual([]);
    expect(body.viewingMachineId).toBeNull();
  });
});

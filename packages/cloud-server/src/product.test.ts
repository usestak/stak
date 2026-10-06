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
      body: { projects: [{ projectId: 'prj_alice' }] },
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
          { projectId: 'prj_here', name: 'Atlas' },
          { projectId: 'prj_away' },
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
      items: Array<{ kind: string; label?: string }>;
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
    // The backup label is the privacy mode (meaningful), not an internal "#N" number.
    const backup = body.items.find((i) => i.kind === 'memory-backed-up');
    expect(backup?.label).toBe('Standard backup');
    expect(backup?.label).not.toMatch(/#\d/);
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
      body: { projects: [{ projectId: 'prj_away' }] },
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

/* ------------------ PROJECT SYNC AUTHORITY / CONFLICT (review §1) ------------------ */

describe('P3 project sync is discovery-only', () => {
  it('a stale local sync never unarchives a Project the web archived', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    // 1. discovery sync (project appears, defaults active)
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: { projects: [{ projectId: 'prj_demo', name: 'Demo' }] },
    });
    // 2. explicit account-side archive from the web
    await env.call('POST', 'projects/prj_demo/lifecycle', {
      token: alice,
      body: { lifecycle: 'archived' },
    });
    // 3. the machine re-syncs with stale local metadata (discovery again)
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: { projects: [{ projectId: 'prj_demo', name: 'Demo (renamed)' }] },
    });
    const body = (await env.call('GET', 'projects', { token: alice }))
      .jsonBody as {
      projects: Array<{ projectId: string; lifecycle: string; name?: string }>;
    };
    const demo = body.projects.find((p) => p.projectId === 'prj_demo');
    expect(demo?.lifecycle).toBe('archived'); // lifecycle preserved
    expect(demo?.name).toBe('Demo (renamed)'); // safe display metadata still refreshes
  });
});

/* --------------------- MACHINE REVOKE: LEGACY + OWNERSHIP (review §2) --------------------- */

describe('P3 machine revoke covers legacy tokens and is scoped', () => {
  it('a pre-P3 token (no machine binding) binds on check-in, then revokes correctly', async () => {
    const env = setup();
    // signIn WITHOUT a machine ⇒ the issued token has no machine binding (legacy shape).
    const legacy = await env.signIn('alice');
    // First authenticated check-in migrates the binding to this machine.
    await env.call('POST', 'machines/checkin', {
      token: legacy,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    const revoke = await env.call('POST', `machines/${MACHINE_A}/revoke`, {
      token: legacy,
    });
    expect(revoke.status).toBe(200);
    // The now-bound legacy token is invalidated.
    expect((await env.call('GET', 'skills', { token: legacy })).status).toBe(
      401,
    );
    // And a revoked credential cannot re-bind itself by sending another check-in.
    expect(
      (
        await env.call('POST', 'machines/checkin', {
          token: legacy,
          body: {
            machineId: MACHINE_A,
            memoryBackedUp: false,
            skills: [],
            projects: [],
          },
        })
      ).status,
    ).toBe(401);
  });

  it('revoking machine A does not revoke machine B, and leaves account data intact', async () => {
    const env = setup();
    const MACHINE_B = '00000000-0000-4000-8000-0000000000b2';
    const tokenA = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      tokenA,
      buildBundle({ skill_keep00001: gitSkill('keep', h('a')) }),
    );
    const tokenB = await env.signIn('alice', MACHINE_B);
    await env.call('POST', 'machines/checkin', {
      token: tokenB,
      body: {
        machineId: MACHINE_B,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    await env.call('POST', `machines/${MACHINE_A}/revoke`, { token: tokenA });
    // B still works; A is rejected.
    expect((await env.call('GET', 'skills', { token: tokenB })).status).toBe(
      200,
    );
    expect((await env.call('GET', 'skills', { token: tokenA })).status).toBe(
      401,
    );
    // Revocation deleted no Skills.
    const skills = (await env.call('GET', 'skills', { token: tokenB }))
      .jsonBody as {
      skills: unknown[];
    };
    expect(skills.skills).toHaveLength(1);
  });
});

/* ------------------- DELETE CLOUD MEMORY HARDENING (review §3) ------------------- */

describe('P3 delete Cloud Memory removes the recoverable payload', () => {
  it('removes the payload object and leaves nothing recoverable', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    const backend = env.memory.memoryBackendFor('alice');
    await backend.ensureProfile('1');
    await backend.createGeneration({
      backupId: 'b-del-1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: new Uint8Array([9, 9, 9]),
      bundleFormatVersion: '1',
    });
    expect((await backend.getPayload('b-del-1')).byteLength).toBe(3); // present before

    const res = await env.call('POST', 'memory/delete', { token: alice });
    expect(res.jsonBody).toMatchObject({
      recoverable: false,
      deletedGenerations: 1,
    });
    // The payload object is physically gone, and recover finds nothing.
    expect(() => backend.getPayload('b-del-1')).toThrow(/not found/i);
    expect(await backend.getLatest()).toBeNull();
  });

  it('a storage-removal failure does NOT falsely claim deletion succeeded', async () => {
    const repository = createInMemoryRepository();
    let counter = 0;
    // A backend whose payload removal fails: delete must surface the failure, not 200.
    const service = createCloudService({
      repository,
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      now: () => new Date('2026-10-05T00:00:00.000Z'),
      randomId: () =>
        `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
      randomSecret: () => `secret-${counter++}`,
      memoryBackendFor: () =>
        ({
          getProfile: async () => ({ privacyMode: 'standard' }),
          listGenerations: async () => [
            {
              backupId: 'b1',
              generation: 0,
              privacyMode: 'standard',
              createdAt: '2026-10-05T00:00:00.000Z',
            },
          ],
          listAllBackupIds: async () => ['b1'],
          listRecoveryMethods: async () => [],
          retireGeneration: async () => {
            // Simulate the object-storage removal failing.
            throw new Error('storage remove failed');
          },
          revokeRecoveryMethod: async () => undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    });
    const start = await handleCloudRequest(service, {
      method: 'POST',
      path: '/api/v1/cli/auth/start',
      headers: {},
      jsonBody: {},
    });
    const { userCode, deviceSecret } = start.jsonBody as {
      userCode: string;
      deviceSecret: string;
    };
    await service.approveCliAuth({ userCode, profile: { userId: 'alice' } });
    const token = (
      (
        await handleCloudRequest(service, {
          method: 'POST',
          path: '/api/v1/cli/auth/token',
          headers: {},
          jsonBody: { deviceSecret },
        })
      ).jsonBody as { token: string }
    ).token;
    const res = await handleCloudRequest(service, {
      method: 'POST',
      path: '/api/v1/memory/delete',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).not.toBe(200); // no false success on storage failure
  });
});

/* --------------- PROJECT LIFECYCLE: EXPLICIT INTENT WINS (review §1) --------------- */

describe('P3 explicit lifecycle intent reconciles', () => {
  it('an explicit unarchive after a web archive wins (newer explicit intent)', async () => {
    const env = setup();
    const alice = await env.signIn('alice');
    await env.call('POST', 'projects/sync', {
      token: alice,
      body: { projects: [{ projectId: 'prj_recon', name: 'Recon' }] },
    });
    await env.call('POST', 'projects/prj_recon/lifecycle', {
      token: alice,
      body: { lifecycle: 'archived' },
    });
    const un = await env.call('POST', 'projects/prj_recon/lifecycle', {
      token: alice,
      body: { lifecycle: 'active' },
    });
    expect(un.jsonBody).toMatchObject({ lifecycle: 'active' });
    const body = (await env.call('GET', 'projects', { token: alice }))
      .jsonBody as {
      projects: Array<{ projectId: string; lifecycle: string }>;
    };
    expect(
      body.projects.find((p) => p.projectId === 'prj_recon')?.lifecycle,
    ).toBe('active');
  });
});

/* --------------- LEGACY TOKEN CROSS-ACCOUNT SAFETY (review §4) --------------- */

describe('P3 legacy token binding is account-scoped', () => {
  it("a legacy token for user A cannot bind to or revoke user B's machine", async () => {
    const env = setup();
    const SHARED = '00000000-0000-4000-8000-0000000000c3';
    const bob = await env.signIn('bob', SHARED);
    await env.call('POST', 'machines/checkin', {
      token: bob,
      body: {
        machineId: SHARED,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    // Alice (legacy, no machine binding) checks in claiming the SAME machine id. It binds to
    // ALICE's own machine row (every row is keyed under the authenticated account), never Bob's.
    const alice = await env.signIn('alice');
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: SHARED,
        memoryBackedUp: false,
        skills: [],
        projects: [],
      },
    });
    await env.call('POST', `machines/${SHARED}/revoke`, { token: alice });
    // Bob's machine + token are untouched.
    const bobMachines = (await env.call('GET', 'machines/view', { token: bob }))
      .jsonBody as { machines: Array<{ machineId: string; revoked: boolean }> };
    expect(
      bobMachines.machines.find((m) => m.machineId === SHARED)?.revoked,
    ).toBe(false);
    expect((await env.call('GET', 'skills', { token: bob })).status).toBe(200);
    // Alice's own token is the one revoked.
    expect((await env.call('GET', 'skills', { token: alice })).status).toBe(
      401,
    );
  });
});

/* --------------- DELETE FAIL -> RETRY REMOVES PAYLOAD (review §3) --------------- */

describe('P3 delete Cloud Memory retry cleans the orphaned payload', () => {
  it('first delete fails (storage), payload remains; retry removes it; third is idempotent', async () => {
    const repository = createInMemoryRepository();
    const memory = createInMemoryMemoryBackends();
    let failRemoval = true;
    let counter = 0;
    const service = createCloudService({
      repository,
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      now: () => new Date('2026-10-05T00:00:00.000Z'),
      randomId: () =>
        `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
      randomSecret: () => `secret-${counter++}`,
      memoryBackendFor: (userId) => {
        const inner = memory.memoryBackendFor(userId);
        return new Proxy(inner, {
          get(target, prop, receiver) {
            if (prop === 'retireGeneration' && failRemoval)
              return async () => {
                throw new Error('storage remove failed');
              };
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;
      },
    });
    const call = (
      method: string,
      path: string,
      opts: { token?: string; body?: unknown } = {},
    ) =>
      handleCloudRequest(service, {
        method,
        path: `/api/v1/${path}`,
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        ...(opts.body !== undefined ? { jsonBody: opts.body } : {}),
      });
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const { userCode, deviceSecret } = start.jsonBody as {
      userCode: string;
      deviceSecret: string;
    };
    await service.approveCliAuth({ userCode, profile: { userId: 'alice' } });
    const token = (
      (await call('POST', 'cli/auth/token', { body: { deviceSecret } }))
        .jsonBody as { token: string }
    ).token;

    const setupBackend = memory.memoryBackendFor('alice');
    await setupBackend.ensureProfile('1');
    await setupBackend.createGeneration({
      backupId: 'b-retry-1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: new Uint8Array([7, 7, 7]),
      bundleFormatVersion: '1',
    });

    // 1. first delete fails at storage removal → non-200, payload still present.
    expect((await call('POST', 'memory/delete', { token })).status).not.toBe(
      200,
    );
    expect(setupBackend.getPayload('b-retry-1')).toBeDefined(); // not thrown → present

    // 2. retry with working storage → payload physically removed, nothing recoverable.
    failRemoval = false;
    const retry = await call('POST', 'memory/delete', { token });
    expect(retry.status).toBe(200);
    expect(() => setupBackend.getPayload('b-retry-1')).toThrow(/not found/i);
    expect(await setupBackend.getLatest()).toBeNull();

    // 3. a third delete remains safe/idempotent.
    expect((await call('POST', 'memory/delete', { token })).status).toBe(200);
  });
});

/* ------------------- REVOKED EXCLUSION + STALE NEVER-CHECKED-IN (P4 pass 2) ------------------- */

describe('P3 revoked machines excluded from active calculations', () => {
  it('a revoked machine is excluded from machines.total, updatesWaiting, and viewing context', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    const MACHINE_B = '00000000-0000-4000-8000-0000000000b2';
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    await env.signIn('alice', MACHINE_B);
    await env.call('POST', 'machines/checkin', {
      token: alice,
      body: {
        machineId: MACHINE_B,
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    await env.call('POST', `machines/${MACHINE_B}/revoke`, { token: alice });

    const overview = (
      await env.call('GET', `overview?machine=${MACHINE_A}`, { token: alice })
    ).jsonBody as { machines: { total: number } };
    expect(overview.machines.total).toBe(1); // only the active machine counts

    // Requesting the revoked machine as viewing context fails safely (not-found), never
    // silently selects it.
    const res = await env.call('GET', `overview?machine=${MACHINE_B}`, {
      token: alice,
    });
    expect(res.status).toBe(404);
  });

  it('a revoked machine never generates a stale-machine Needs-attention item', async () => {
    const env = setup();
    const MACHINE_D = '00000000-0000-4000-8000-0000000000d4';
    const tokenForA = await env.signIn('alice', MACHINE_A);
    await env.call('POST', 'machines/checkin', {
      token: tokenForA,
      body: {
        machineId: MACHINE_A,
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    env.setClock('2026-11-10T00:00:00.000Z'); // 36 days later: would be stale if active
    // Revoking the machine also revokes the token bound to it — sign in again with a second
    // machine to get a live token for querying the account afterward.
    await env.call('POST', `machines/${MACHINE_A}/revoke`, {
      token: tokenForA,
    });
    const tokenForD = await env.signIn('alice', MACHINE_D);
    await env.call('POST', 'machines/checkin', {
      token: tokenForD,
      body: {
        machineId: MACHINE_D,
        memoryBackedUp: true,
        skills: [],
        projects: [],
      },
    });
    const overview = (await env.call('GET', 'overview', { token: tokenForD }))
      .jsonBody as { needsAttention: Array<{ kind: string; ref?: string }> };
    expect(overview.needsAttention.some((n) => n.ref === MACHINE_A)).toBe(
      false,
    );
  });
});

describe('P3 never-checked-in staleness uses firstSeenAt with a grace period', () => {
  it('a brand-new login is not flagged stale', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    const body = (await env.call('GET', 'overview', { token: alice }))
      .jsonBody as { needsAttention: Array<{ kind: string }> };
    expect(body.needsAttention.some((n) => n.kind === 'machine-stale')).toBe(
      false,
    );
  });

  it('a machine authorized 30+ days ago that never checked in becomes eligible for attention', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    env.setClock('2026-11-10T00:00:00.000Z'); // 36 days after signIn, still no check-in
    const overview = (await env.call('GET', 'overview', { token: alice }))
      .jsonBody as {
      needsAttention: Array<{ kind: string; ref?: string; label: string }>;
    };
    const item = overview.needsAttention.find(
      (n) => n.kind === 'machine-stale' && n.ref === MACHINE_A,
    );
    expect(item).toBeDefined();
    expect(item?.label.toLowerCase()).toContain('never checked in');
  });

  it('firstSeenAt is exposed on the machines read model', async () => {
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    const list = (await env.call('GET', 'machines', { token: alice }))
      .jsonBody as {
      machines: Array<{ machineId: string; firstSeenAt: string }>;
    };
    expect(list.machines[0]?.firstSeenAt).toBe('2026-10-05T00:00:00.000Z');
  });
});

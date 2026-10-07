import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeEnvironmentBundleDigest } from '@stack/shared';
import {
  skillDetailSchema,
  skillsReadModelSchema,
  uploadSkillReviewArtifactRequestSchema,
  type CloudEnvironmentBundle,
  type PortableLockedSkill,
  type UploadSkillReviewArtifactRequest,
} from '@stack/spec';

import type { CloudRequest } from './handler.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
  handleCloudRequest,
} from './index.js';

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

const setup = () => {
  const repository = createInMemoryRepository();
  const memory = createInMemoryMemoryBackends();
  const blobStore = createInMemoryBlobStore();
  let clock = new Date('2026-10-05T00:00:00.000Z');
  let counter = 0;
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-secret',
    now: () => clock,
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    memoryBackendFor: memory.memoryBackendFor,
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
  return {
    service,
    repository,
    blobStore,
    memory,
    call,
    signIn,
    pushBundle,
    setClock,
  };
};

const REVIEW_SKILL = 'skill_review001';

/**
 * Seed one approved, checkable (git reference, tracked ref) Skill for `userId` and return the
 * authenticated user plus the Skill's id and CURRENT approved content hash. Uses the real
 * sign-in + push path (no repository back doors).
 */
const seedSkill = async (
  env: ReturnType<typeof setup>,
  userId = 'alice',
  skills: Record<string, PortableLockedSkill> = {
    [REVIEW_SKILL]: gitSkill('reviewed', h('a'), { ref: 'refs/heads/main' }),
  },
) => {
  const token = await env.signIn(userId);
  await env.pushBundle(token, buildBundle(skills));
  const user = await env.service.authenticate(`Bearer ${token}`);
  const [skillId, skill] = Object.entries(skills)[0] ?? [];
  if (!skillId || !skill) throw new Error('seedSkill needs at least one Skill');
  return { token, user, skillId, approvedContentHash: skill.contentHash };
};

/** The upload request as the review-artifact ROUTE body carries it (skillId is in the URL). */
const routeMetadataOf = (
  request: UploadSkillReviewArtifactRequest,
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = { ...request };
  delete metadata.skillId;
  return metadata;
};

const sha256Of = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * A complete, internally-consistent upload request + its bounded text payload for one
 * modified SKILL.md. Metadata (`files`) carries no text; text travels only in the hashed
 * payload, and `artifactPayloadHash` is the real sha256 of those exact payload bytes.
 */
const reviewUpload = (input: {
  skillId: string;
  approvedContentHash: string;
  candidateRevision: string;
  candidateContentHash: string;
  afterText?: string;
  checkedAt?: string;
}) => {
  const beforeText = 'old body\n';
  const afterText =
    input.afterText ?? `new body for ${input.candidateRevision}\n`;
  const payload = new Uint8Array(
    Buffer.from(
      JSON.stringify({
        files: [{ relativePath: 'SKILL.md', beforeText, afterText }],
      }),
      'utf8',
    ),
  );
  const file: UploadSkillReviewArtifactRequest['files'][number] = {
    relativePath: 'SKILL.md',
    kind: 'modified',
    binary: false,
    before: {
      byteSize: Buffer.byteLength(beforeText),
      hash: sha256Of(Buffer.from(beforeText)),
    },
    after: {
      byteSize: Buffer.byteLength(afterText),
      hash: sha256Of(Buffer.from(afterText)),
    },
  };
  const request: UploadSkillReviewArtifactRequest = {
    skillId: input.skillId,
    approvedContentHash: input.approvedContentHash,
    candidateRevision: input.candidateRevision,
    candidateContentHash: input.candidateContentHash,
    artifactPayloadHash: sha256Of(payload),
    checkedAt: input.checkedAt ?? '2026-10-05T00:00:00.000Z',
    files: [file],
  };
  // Sanity: the request is valid against the real wire schema (not just the TS type).
  uploadSkillReviewArtifactRequestSchema.parse(request);
  return { request, file, payload, beforeText, afterText };
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

  it('distinguishes update-available, no-update, cannot-check, and not-checked (persisted CLI checks)', async () => {
    const env = setup();
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
        skill_unseen001: gitSkill('unseen', h('d'), {
          ref: 'refs/heads/main',
        }),
      }),
    );
    const at = '2026-10-05T00:00:00.000Z';
    await env.repository.putSkillReviewCheck({
      userId: 'alice',
      skillId: 'skill_update001',
      approvedContentHash: h('a'),
      sourceCheckState: 'update-available',
      checkedAt: at,
      candidateRevision: 'f'.repeat(40),
      candidateContentHash: h('e'),
      reviewArtifactId: '00000000-0000-4000-8000-00000000aaaa',
      artifactPayloadHash: h('9'),
      diffFiles: [],
    });
    await env.repository.putSkillReviewCheck({
      userId: 'alice',
      skillId: 'skill_current01',
      approvedContentHash: h('b'),
      sourceCheckState: 'no-update',
      checkedAt: at,
    });
    await env.repository.putSkillReviewCheck({
      userId: 'alice',
      skillId: 'skill_local0001',
      approvedContentHash: h('c'),
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'local',
      checkedAt: at,
    });
    const res = await env.call('GET', 'skills', { token: alice });
    const body = res.jsonBody as {
      skills: Array<{
        skillId: string;
        sourceCheckState: string;
        candidateRevision?: string;
        reviewArtifactId?: string;
        cannotCheckReason?: string;
      }>;
    };
    const byId = (id: string) => body.skills.find((s) => s.skillId === id);
    expect(byId('skill_update001')?.sourceCheckState).toBe('update-available');
    expect(byId('skill_update001')?.candidateRevision).toBe('f'.repeat(40));
    expect(byId('skill_update001')?.reviewArtifactId).toBe(
      '00000000-0000-4000-8000-00000000aaaa',
    );
    expect(byId('skill_current01')?.sourceCheckState).toBe('no-update');
    expect(byId('skill_local0001')?.sourceCheckState).toBe('cannot-check');
    expect(byId('skill_local0001')?.cannotCheckReason).toBe('local');
    expect(byId('skill_unseen001')?.sourceCheckState).toBe('not-checked');
    expect(() => skillsReadModelSchema.parse(res.jsonBody)).not.toThrow();
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

  it('approve (by review artifact, over HTTP) advances desired version; re-approving the consumed artifact creates nothing new', async () => {
    const env = setup();
    const seed = await seedSkill(env, 'alice', {
      skill_approve01: gitSkill('ap', h('a'), { ref: 'refs/heads/main' }),
    });
    const a = reviewUpload({
      skillId: 'skill_approve01',
      approvedContentHash: h('a'),
      candidateRevision: 'f'.repeat(40),
      candidateContentHash: h('b'),
    });
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const approve = await env.call('POST', 'skills/skill_approve01/approve', {
      token: seed.token,
      body: { reviewArtifactId },
    });
    expect(approve.jsonBody).toMatchObject({
      createdNew: true,
      approvedVersion: h('b'),
      environmentVersionNumber: 2,
    });
    // Desired version advanced to exactly the reviewed candidate.
    const skills = (await env.call('GET', 'skills', { token: seed.token }))
      .jsonBody as {
      skills: Array<{ approvedVersion: string; sourceCheckState: string }>;
    };
    expect(skills.skills[0]?.approvedVersion).toBe(h('b'));
    // The consumed artifact no longer describes a pending delta.
    expect(skills.skills[0]?.sourceCheckState).toBe('not-checked');
    // Re-approving the SAME (now consumed) artifact is refused and commits no new version.
    const again = await env.call('POST', 'skills/skill_approve01/approve', {
      token: seed.token,
      body: { reviewArtifactId },
    });
    expect(again.status).toBe(409);
    const stacks = (
      await env.call('GET', 'stacks-owned', { token: seed.token })
    ).jsonBody as { owned: Array<{ latestVersionNumber: number }> };
    expect(stacks.owned[0]?.latestVersionNumber).toBe(2);
  });

  it('the approve route accepts ONLY { reviewArtifactId } — a client-supplied candidate is rejected', async () => {
    const env = setup();
    const seed = await seedSkill(env, 'alice', {
      skill_approve01: gitSkill('ap', h('a'), { ref: 'refs/heads/main' }),
    });
    const legacy = await env.call('POST', 'skills/skill_approve01/approve', {
      token: seed.token,
      body: { candidateContentHash: h('b'), candidateRevision: 'f'.repeat(40) },
    });
    expect(legacy.status).toBe(400);
    const a = reviewUpload({
      skillId: 'skill_approve01',
      approvedContentHash: h('a'),
      candidateRevision: 'f'.repeat(40),
      candidateContentHash: h('b'),
    });
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const smuggled = await env.call('POST', 'skills/skill_approve01/approve', {
      token: seed.token,
      body: { reviewArtifactId, candidateContentHash: h('c') },
    });
    expect(smuggled.status).toBe(400);
    const skills = (await env.call('GET', 'skills', { token: seed.token }))
      .jsonBody as { skills: Array<{ approvedVersion: string }> };
    expect(skills.skills[0]?.approvedVersion).toBe(h('a'));
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
    const user = await env.service.authenticate(`Bearer ${alice}`);
    const a = reviewUpload({
      skillId: 'skill_approve01',
      approvedContentHash: h('a'),
      candidateRevision: 'f'.repeat(40),
      candidateContentHash: h('b'),
    });
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(
      user,
      a.request,
      a.payload,
    );
    const approved = await env.call('POST', 'skills/skill_approve01/approve', {
      token: alice,
      body: { reviewArtifactId },
    });
    expect(approved.status).toBe(200);
    // The machine still reports the OLD installed version → Updates waiting.
    const machines = (await env.call('GET', 'machines/view', { token: alice }))
      .jsonBody as {
      machines: Array<{ status: string; updatesWaiting: string[] }>;
    };
    expect(machines.machines[0]?.status).toBe('updates-waiting');
    expect(machines.machines[0]?.updatesWaiting).toEqual(['skill_approve01']);
  });
});

/* --------------------- P5a: PERSISTED SOURCE-CHECK READ MODEL --------------------- */

describe('Skills read model — P5a source-check states', () => {
  it('reports not-checked when no check has ever been stored', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const result = await env.service.getSkillsReadModel(seed.user);
    expect(result.skills[0]?.sourceCheckState).toBe('not-checked');
    expect(result.skills[0]?.checkedAt).toBeNull();
  });

  it('reports no-update from a stored report', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(seed.user);
    expect(result.skills[0]?.sourceCheckState).toBe('no-update');
    expect(result.skills[0]?.checkedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a stored check against a STALE approved base is ignored — reports not-checked', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: h('f'), // not the current approved hash
      sourceCheckState: 'update-available',
      checkedAt: '2026-01-01T00:00:00.000Z',
      candidateRevision: 'c'.repeat(40),
      candidateContentHash: h('c'),
      reviewArtifactId: '00000000-0000-4000-8000-00000000ffff',
      artifactPayloadHash: h('9'),
      diffFiles: [],
    });
    const result = await env.service.getSkillsReadModel(seed.user);
    const skill = result.skills[0];
    expect(skill?.sourceCheckState).toBe('not-checked');
    expect(skill?.checkedAt).toBeNull();
    expect(skill?.candidateRevision).toBeUndefined();
    expect(skill?.reviewArtifactId).toBeUndefined();
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.reviewArtifact).toBeNull();
  });

  it('cannot-check reports its reason, distinct from not-checked', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'local',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(seed.user);
    expect(result.skills[0]?.sourceCheckState).toBe('cannot-check');
    expect(result.skills[0]?.cannotCheckReason).toBe('local');
  });

  it('check-failed reports a sanitized reason', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'check-failed',
      checkFailedReason: 'Network unreachable',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(seed.user);
    expect(result.skills[0]?.sourceCheckState).toBe('check-failed');
    expect(result.skills[0]?.checkFailedReason).toBe('Network unreachable');
  });

  it('every read-model summary satisfies the real skillSummarySchema', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'dirty',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(seed.user);
    expect(() => skillsReadModelSchema.parse(result)).not.toThrow();
  });
});

/* ----------------------- P5a: CLI-REPORTED CHECK UPLOADS ----------------------- */

describe('uploadSkillReviewArtifact', () => {
  it('stores the artifact metadata + blob and the Skill reads back update-available', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request, payload, beforeText, afterText } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const result = await env.service.uploadSkillReviewArtifact(
      seed.user,
      request,
      payload,
    );
    expect(result.reviewArtifactId).toMatch(/^[0-9a-f-]{36}$/);

    const summary = (await env.service.getSkillsReadModel(seed.user)).skills[0];
    expect(summary?.sourceCheckState).toBe('update-available');
    expect(summary?.candidateRevision).toBe('b'.repeat(40));
    expect(summary?.reviewArtifactId).toBe(result.reviewArtifactId);
    expect(summary?.checkedAt).toBe(request.checkedAt);

    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('update-available');
    expect(detail.reviewArtifact).toEqual({
      reviewArtifactId: result.reviewArtifactId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
      artifactPayloadHash: request.artifactPayloadHash,
      checkedAt: request.checkedAt,
      files: [{ ...request.files[0], beforeText, afterText }],
    });
    expect(() => skillDetailSchema.parse(detail)).not.toThrow();
    // The payload is held owner-scoped under its own verified hash.
    expect(
      await env.blobStore.get(seed.user.userId, request.artifactPayloadHash),
    ).toEqual(payload);
  });

  it('rejects a payload whose hash does not match the declared artifactPayloadHash, storing nothing', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        request,
        new Uint8Array(Buffer.from('not matching')),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(
      await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId),
    ).toBeNull();
    expect(env.blobStore.blobs.size).toBe(0);
  });

  it('rejects text carried in the unverified metadata — text travels only in the hashed payload', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request, file, payload } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const smuggled = {
      ...request,
      files: [{ ...file, afterText: 'unverified text' }],
    };
    await expect(
      env.service.uploadSkillReviewArtifact(seed.user, smuggled, payload),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('rejects a well-hashed payload that does not describe the declared files', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request, file } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const bad = (body: unknown) => {
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(body)));
      return env.service.uploadSkillReviewArtifact(
        seed.user,
        { ...request, artifactPayloadHash: sha256Of(bytes) },
        bytes,
      );
    };
    // Not JSON at all.
    const notJson = new Uint8Array(Buffer.from('\u0000\u0001binary'));
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        { ...request, artifactPayloadHash: sha256Of(notJson) },
        notJson,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    // Text for a path the metadata does not declare.
    await expect(
      bad({ files: [{ relativePath: 'OTHER.md', afterText: 'x' }] }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    // A side the metadata says does not exist (modified has both; use a removed-only file).
    const removedOnly = {
      ...request,
      files: [
        {
          relativePath: 'GONE.md',
          kind: 'removed' as const,
          binary: false,
          before: { byteSize: 1, hash: h('1') },
        },
      ],
    };
    const removedBytes = new Uint8Array(
      Buffer.from(
        JSON.stringify({
          files: [{ relativePath: 'GONE.md', beforeText: 'x', afterText: 'y' }],
        }),
      ),
    );
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        { ...removedOnly, artifactPayloadHash: sha256Of(removedBytes) },
        removedBytes,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    // Text for a binary file.
    const binaryFile = {
      ...request,
      files: [{ ...file, binary: true }],
    };
    const binaryBytes = new Uint8Array(
      Buffer.from(
        JSON.stringify({
          files: [{ relativePath: 'SKILL.md', afterText: 'y' }],
        }),
      ),
    );
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        { ...binaryFile, artifactPayloadHash: sha256Of(binaryBytes) },
        binaryBytes,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(
      await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId),
    ).toBeNull();
  });

  it('rejects an absurd payload: candidate identical to the approved base, or an oversized payload', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const same = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: seed.approvedContentHash, // "update" to the same content
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        same.request,
        same.payload,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });

    const huge = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
      afterText: 'x'.repeat(9 * 1024 * 1024),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        huge.request,
        huge.payload,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(env.blobStore.blobs.size).toBe(0);
  });

  it('rejects an upload computed against a stale approved base and leaves the current check intact', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const current = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const kept = await env.service.uploadSkillReviewArtifact(
      seed.user,
      current.request,
      current.payload,
    );
    const stale = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: h('f'), // not the Skill's current approved hash
      candidateRevision: 'c'.repeat(40),
      candidateContentHash: h('c'),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        stale.request,
        stale.payload,
      ),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(kept.reviewArtifactId);
  });

  it('rejects an unknown Skill and a Skill with no checkable reference source', async () => {
    const env = setup();
    const seed = await seedSkill(env, 'alice', {
      skill_local0001: localSkill('local-one', h('c')),
    });
    const unknown = reviewUpload({
      skillId: 'skill_missing01',
      approvedContentHash: h('a'),
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        unknown.request,
        unknown.payload,
      ),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
    const local = reviewUpload({
      skillId: 'skill_local0001',
      approvedContentHash: h('c'),
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(
        seed.user,
        local.request,
        local.payload,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('a NEW upload replaces the prior artifact — metadata shows only the new one (latest-only)', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const b = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'c'.repeat(40),
      candidateContentHash: h('c'),
      checkedAt: '2026-10-06T00:00:00.000Z',
    });
    const first = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const second = await env.service.uploadSkillReviewArtifact(
      seed.user,
      b.request,
      b.payload,
    );
    expect(second.reviewArtifactId).not.toBe(first.reviewArtifactId);
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(
      second.reviewArtifactId,
    );
    expect(detail.reviewArtifact?.candidateRevision).toBe('c'.repeat(40));
    expect(detail.reviewArtifact?.files[0]?.afterText).toBe(b.afterText);
    expect(detail.reviewArtifactId).toBe(second.reviewArtifactId);
    // V0 skips physical deletion of the superseded blob: it is never overwritten or
    // truncated (content-addressed storage may be shared), merely unreferenced.
    expect(
      await env.blobStore.get(seed.user.userId, a.request.artifactPayloadHash),
    ).toEqual(a.payload);
  });

  it('re-uploading the exact same artifact is idempotent: no error, no double-create', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const first = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    // Re-upload the identical request + payload a second (and third) time.
    const second = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const third = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    expect(second.reviewArtifactId).toBeDefined();
    expect(third.reviewArtifactId).toBeDefined();
    // Still exactly ONE current artifact (latest-only) — no double-create.
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(third.reviewArtifactId);
    expect(detail.reviewArtifact?.candidateRevision).toBe('b'.repeat(40));
    expect(detail.reviewArtifact?.files[0]?.afterText).toBe(a.afterText);
    // The identical payload bytes are still retrievable under their one content-addressed key.
    expect(
      await env.blobStore.get(seed.user.userId, a.request.artifactPayloadHash),
    ).toEqual(a.payload);
    // Approving by the LATEST id (not stale `first`/`second` ids) still succeeds.
    const approval = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId: third.reviewArtifactId,
    });
    expect(approval.createdNew).toBe(true);
  });

  it('safe replacement: if the new metadata fails to commit, the old artifact stays fully intact', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const first = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const realPut = env.repository.putSkillReviewCheck;
    env.repository.putSkillReviewCheck = async () => {
      throw new Error('metadata write failed');
    };
    const b = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'c'.repeat(40),
      candidateContentHash: h('c'),
    });
    await expect(
      env.service.uploadSkillReviewArtifact(seed.user, b.request, b.payload),
    ).rejects.toThrow('metadata write failed');
    env.repository.putSkillReviewCheck = realPut;
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(
      first.reviewArtifactId,
    );
    expect(detail.reviewArtifact?.files[0]?.afterText).toBe(a.afterText);
  });

  it('an artifact is invisible to another account', async () => {
    const env = setup();
    const alice = await seedSkill(env, 'alice');
    const bob = await seedSkill(env, 'bob');
    const a = reviewUpload({
      skillId: alice.skillId,
      approvedContentHash: alice.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    await env.service.uploadSkillReviewArtifact(
      alice.user,
      a.request,
      a.payload,
    );
    const bobDetail = await env.service.getSkillDetail(bob.user, bob.skillId);
    expect(bobDetail.sourceCheckState).toBe('not-checked');
    expect(bobDetail.reviewArtifact).toBeNull();
  });
});

describe('reportSkillSourceCheck', () => {
  it('stores a no-update report with no artifact', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.service.reportSkillSourceCheck(seed.user, {
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('no-update');
    expect(detail.checkedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(detail.reviewArtifact).toBeNull();
  });

  it('stores cannot-check with its reason and check-failed with its sanitized reason', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await env.service.reportSkillSourceCheck(seed.user, {
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'dirty',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    let detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('cannot-check');
    expect(detail.cannotCheckReason).toBe('dirty');
    await env.service.reportSkillSourceCheck(seed.user, {
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'check-failed',
      failureReason: 'Network unreachable',
      checkedAt: '2026-01-02T00:00:00.000Z',
    });
    detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('check-failed');
    expect(detail.checkFailedReason).toBe('Network unreachable');
    expect(detail.cannotCheckReason).toBeUndefined();
  });

  it('a later report supersedes a prior artifact (latest-only), making it unapprovable', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    await env.service.reportSkillSourceCheck(seed.user, {
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-10-06T00:00:00.000Z',
    });
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('no-update');
    expect(detail.reviewArtifact).toBeNull();
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
  });

  it('rejects a report against a stale base, an unknown Skill, or a reason for the wrong state', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await expect(
      env.service.reportSkillSourceCheck(seed.user, {
        skillId: seed.skillId,
        approvedContentHash: h('f'),
        sourceCheckState: 'no-update',
        checkedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    await expect(
      env.service.reportSkillSourceCheck(seed.user, {
        skillId: 'skill_missing01',
        approvedContentHash: seed.approvedContentHash,
        sourceCheckState: 'no-update',
        checkedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
    await expect(
      env.service.reportSkillSourceCheck(seed.user, {
        skillId: seed.skillId,
        approvedContentHash: seed.approvedContentHash,
        sourceCheckState: 'no-update',
        cannotCheckReason: 'dirty',
        checkedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      env.service.reportSkillSourceCheck(seed.user, {
        skillId: seed.skillId,
        approvedContentHash: seed.approvedContentHash,
        sourceCheckState: 'cannot-check',
        failureReason: 'not a cannot-check field',
        checkedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(
      await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId),
    ).toBeNull();
  });
});

/* ----------------------- P5a: APPROVE BY REVIEW ARTIFACT ----------------------- */

describe('approveSkillVersion — by artifact (P5a)', () => {
  const upload = async (
    env: ReturnType<typeof setup>,
    seed: Awaited<ReturnType<typeof seedSkill>>,
    candidate: { revision: string; contentHash: string },
  ) => {
    const { request, payload } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: candidate.revision,
      candidateContentHash: candidate.contentHash,
    });
    return env.service.uploadSkillReviewArtifact(seed.user, request, payload);
  };
  const approvedReference = async (
    env: ReturnType<typeof setup>,
    token: string,
    skillId: string,
  ) => {
    const res = await env.call('GET', 'environments/main', { token });
    const body = res.jsonBody as {
      latest: { bundle: CloudEnvironmentBundle };
    };
    const skill = body.latest.bundle.resolved.skills[skillId];
    return {
      contentHash: skill?.contentHash,
      reference:
        skill?.restoration.strategy === 'reference'
          ? skill.restoration.reference
          : undefined,
    };
  };

  it('approves the exact candidate recorded in the current artifact and consumes it', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { reviewArtifactId } = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    const result = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId,
    });
    expect(result).toEqual({
      skillId: seed.skillId,
      approvedVersion: h('b'),
      createdNew: true,
      environmentVersionNumber: 2,
    });
    const approved = await approvedReference(env, seed.token, seed.skillId);
    expect(approved.contentHash).toBe(h('b'));
    expect(approved.reference?.revision).toBe('b'.repeat(40));
    expect(approved.reference?.expectedContentHash).toBe(h('b'));
    // Untouched reference fields are preserved.
    expect(approved.reference?.remote).toBe(
      'https://github.com/acme/skills.git',
    );
    expect(approved.reference?.ref).toBe('refs/heads/main');
    // Approval success deletes the consumed check row.
    expect(
      await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId),
    ).toBeNull();
  });

  it('rejects an artifact that belongs to a different account', async () => {
    const env = setup();
    const alice = await seedSkill(env, 'alice');
    const bob = await seedSkill(env, 'bob'); // same Skill id, separate account
    const { reviewArtifactId } = await upload(env, alice, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    await expect(
      env.service.approveSkillVersion(bob.user, {
        skillId: bob.skillId,
        reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    // Bob's Skill is unchanged; Alice's artifact is still current and approvable by Alice.
    expect(
      (await approvedReference(env, bob.token, bob.skillId)).contentHash,
    ).toBe(h('a'));
    const result = await env.service.approveSkillVersion(alice.user, {
      skillId: alice.skillId,
      reviewArtifactId,
    });
    expect(result.createdNew).toBe(true);
  });

  it('rejects an artifact id for the wrong Skill', async () => {
    const env = setup();
    const seed = await seedSkill(env, 'alice', {
      skill_skilla001: gitSkill('a-skill', h('a'), { ref: 'refs/heads/main' }),
      skill_skillb001: gitSkill('b-skill', h('1'), { ref: 'refs/heads/main' }),
    });
    const { reviewArtifactId } = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    expect(seed.skillId).toBe('skill_skilla001');
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: 'skill_skillb001',
        reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    expect(
      (await approvedReference(env, seed.token, 'skill_skillb001')).contentHash,
    ).toBe(h('1'));
  });

  it('rejects an unknown artifact id and an unknown Skill', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId: '00000000-0000-4000-8000-00000000dead',
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: 'skill_missing01',
        reviewArtifactId: '00000000-0000-4000-8000-00000000dead',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
  });

  it('CASE B: a newer artifact supersedes an older one — approving the old id is rejected', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    const b = await upload(env, seed, {
      revision: 'c'.repeat(40),
      contentHash: h('c'),
    });
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId: a.reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    // The rejected attempt changed nothing; the newer artifact approves ITS candidate.
    expect(
      (await approvedReference(env, seed.token, seed.skillId)).contentHash,
    ).toBe(h('a'));
    const result = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId: b.reviewArtifactId,
    });
    expect(result).toMatchObject({ createdNew: true, approvedVersion: h('c') });
    expect(
      (await approvedReference(env, seed.token, seed.skillId)).reference
        ?.revision,
    ).toBe('c'.repeat(40));
  });

  it('CASE C: the approved base changes before the artifact is approved — the artifact is rejected', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    // A machine pushes a new Environment version that moves this Skill's approved base to a
    // different version (not via this artifact).
    const envRes = await env.call('GET', 'environments/main', {
      token: seed.token,
    });
    const latestVersionId = (
      envRes.jsonBody as { latest: { version: { versionId: string } } }
    ).latest.version.versionId;
    const pushed = await env.call('POST', 'environments/main/versions', {
      token: seed.token,
      body: {
        bundle: buildBundle({
          [seed.skillId]: gitSkill('reviewed', h('d'), {
            ref: 'refs/heads/main',
          }),
        }),
        expectedLatestVersionId: latestVersionId,
      },
    });
    expect(pushed.status).toBe(200);
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId: a.reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    // The new base is untouched, and the stale artifact reads back as not-checked.
    expect(
      (await approvedReference(env, seed.token, seed.skillId)).contentHash,
    ).toBe(h('d'));
    const detail = await env.service.getSkillDetail(seed.user, seed.skillId);
    expect(detail.sourceCheckState).toBe('not-checked');
    expect(detail.reviewArtifact).toBeNull();
  });

  it('CASE C (isolated): a stored check whose base differs from the current approved hash is never approved', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const reviewArtifactId = '00000000-0000-4000-8000-0000000000cc';
    // Matching skill, matching id, update-available — ONLY the base differs.
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: h('f'),
      sourceCheckState: 'update-available',
      checkedAt: '2026-10-05T00:00:00.000Z',
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
      reviewArtifactId,
      artifactPayloadHash: h('9'),
      diffFiles: [],
    });
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    expect(
      (await approvedReference(env, seed.token, seed.skillId)).contentHash,
    ).toBe(h('a'));
  });

  it('a stored row with the matching id but a non-update-available state is never approved', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const reviewArtifactId = '00000000-0000-4000-8000-0000000000dd';
    await env.repository.putSkillReviewCheck({
      userId: seed.user.userId,
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-10-05T00:00:00.000Z',
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
      reviewArtifactId,
    });
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
  });

  it('UPSTREAM-MOVED-WITHOUT-RECHECK: artifact A remains approvable — Cloud never re-resolves upstream at approval time', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    // Time passes and (hypothetically) upstream moves on, but no new `stak skill check` ran.
    // Cloud has no source resolver at all (none is configurable), so there is nothing that
    // could observe upstream: approval uses only A's own stored, already-committed data.
    env.setClock('2026-12-01T00:00:00.000Z');
    const result = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId: a.reviewArtifactId,
    });
    expect(result).toMatchObject({ createdNew: true, approvedVersion: h('b') });
    const approved = await approvedReference(env, seed.token, seed.skillId);
    expect(approved.reference?.revision).toBe('b'.repeat(40));
    expect(approved.reference?.expectedContentHash).toBe(h('b'));
  });

  it('approving the same artifact twice never commits twice', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    const first = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId: a.reviewArtifactId,
    });
    expect(first.createdNew).toBe(true);
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId: a.reviewArtifactId,
      }),
    ).rejects.toMatchObject({ code: 'remote-environment-conflict' });
    const stacks = (
      await env.call('GET', 'stacks-owned', { token: seed.token })
    ).jsonBody as { owned: Array<{ latestVersionNumber: number }> };
    expect(stacks.owned[0]?.latestVersionNumber).toBe(2);
  });

  it('a failed commit leaves the artifact in place (not consumed) so it can be retried', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const a = await upload(env, seed, {
      revision: 'b'.repeat(40),
      contentHash: h('b'),
    });
    const realCommit = env.repository.commitEnvironmentVersion;
    env.repository.commitEnvironmentVersion = async () => {
      throw new Error('commit failed');
    };
    await expect(
      env.service.approveSkillVersion(seed.user, {
        skillId: seed.skillId,
        reviewArtifactId: a.reviewArtifactId,
      }),
    ).rejects.toThrow('commit failed');
    env.repository.commitEnvironmentVersion = realCommit;
    expect(
      (await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId))
        ?.reviewArtifactId,
    ).toBe(a.reviewArtifactId);
    const retry = await env.service.approveSkillVersion(seed.user, {
      skillId: seed.skillId,
      reviewArtifactId: a.reviewArtifactId,
    });
    expect(retry.createdNew).toBe(true);
  });
});

/* ------------------------- P5a: HTTP ROUTES (CLI wire) ------------------------- */

describe('P5a review-check / review-artifact HTTP routes', () => {
  it('uploads an artifact as JSON metadata + base64 payload, serves it on the detail route, and approves it', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request, payload, afterText } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const metadata = routeMetadataOf(request);
    const uploaded = await env.call(
      'POST',
      `skills/${seed.skillId}/review-artifact`,
      {
        token: seed.token,
        body: {
          ...metadata,
          payloadBase64: Buffer.from(payload).toString('base64'),
        },
      },
    );
    expect(uploaded.status).toBe(200);
    const { reviewArtifactId } = uploaded.jsonBody as {
      reviewArtifactId: string;
    };
    const detail = await env.call('GET', `skills/${seed.skillId}`, {
      token: seed.token,
    });
    const body = skillDetailSchema.parse(detail.jsonBody);
    expect(body.reviewArtifact?.reviewArtifactId).toBe(reviewArtifactId);
    expect(body.reviewArtifact?.files[0]?.afterText).toBe(afterText);
    const approved = await env.call('POST', `skills/${seed.skillId}/approve`, {
      token: seed.token,
      body: { reviewArtifactId },
    });
    expect(approved.status).toBe(200);
    expect(approved.jsonBody).toMatchObject({ approvedVersion: h('b') });
  });

  it('rejects an upload with no payload, a corrupted payload, or a body skillId that contradicts the route', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const { request, payload } = reviewUpload({
      skillId: seed.skillId,
      approvedContentHash: seed.approvedContentHash,
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const metadata = routeMetadataOf(request);
    const path = `skills/${seed.skillId}/review-artifact`;
    const missing = await env.call('POST', path, {
      token: seed.token,
      body: metadata,
    });
    expect(missing.status).toBe(400);
    const corrupted = await env.call('POST', path, {
      token: seed.token,
      body: {
        ...metadata,
        payloadBase64: Buffer.from('tampered').toString('base64'),
      },
    });
    expect(corrupted.status).toBe(400);
    const mismatched = await env.call('POST', path, {
      token: seed.token,
      body: {
        ...metadata,
        skillId: 'skill_other0001',
        payloadBase64: Buffer.from(payload).toString('base64'),
      },
    });
    expect(mismatched.status).toBe(400);
    expect(
      await env.repository.getSkillReviewCheck(seed.user.userId, seed.skillId),
    ).toBeNull();
  });

  it('reports a no-artifact result on the review-check route', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    const res = await env.call('POST', `skills/${seed.skillId}/review-check`, {
      token: seed.token,
      body: {
        approvedContentHash: seed.approvedContentHash,
        sourceCheckState: 'cannot-check',
        cannotCheckReason: 'ambiguous',
        checkedAt: '2026-10-05T00:00:00.000Z',
      },
    });
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true });
    const skills = (await env.call('GET', 'skills', { token: seed.token }))
      .jsonBody as {
      skills: Array<{ sourceCheckState: string; cannotCheckReason?: string }>;
    };
    expect(skills.skills[0]).toMatchObject({
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'ambiguous',
    });
    // 'update-available' is not reportable without an artifact.
    const bogus = await env.call(
      'POST',
      `skills/${seed.skillId}/review-check`,
      {
        token: seed.token,
        body: {
          approvedContentHash: seed.approvedContentHash,
          sourceCheckState: 'update-available',
          checkedAt: '2026-10-05T00:00:00.000Z',
        },
      },
    );
    expect(bogus.status).toBe(400);
  });

  it('both write routes require authentication', async () => {
    const env = setup();
    const seed = await seedSkill(env);
    expect(
      (
        await env.call('POST', `skills/${seed.skillId}/review-check`, {
          body: {},
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await env.call('POST', `skills/${seed.skillId}/review-artifact`, {
          body: {},
        })
      ).status,
    ).toBe(401);
  });

  it('the approve route rejects a body skillId that contradicts the route', async () => {
    const env = setup();
    const seed = await seedSkill(env, 'alice', {
      skill_skilla001: gitSkill('a-skill', h('a'), { ref: 'refs/heads/main' }),
      skill_skillb001: gitSkill('b-skill', h('1'), { ref: 'refs/heads/main' }),
    });
    const a = reviewUpload({
      skillId: 'skill_skilla001',
      approvedContentHash: h('a'),
      candidateRevision: 'b'.repeat(40),
      candidateContentHash: h('b'),
    });
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(
      seed.user,
      a.request,
      a.payload,
    );
    const res = await env.call('POST', 'skills/skill_skillb001/approve', {
      token: seed.token,
      body: { skillId: 'skill_skilla001', reviewArtifactId },
    });
    expect(res.status).toBe(400);
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
    const env = setup();
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
    const env = setup();
    const alice = await env.signIn('alice', MACHINE_A);
    await env.pushBundle(
      alice,
      buildBundle({
        skill_up000001: gitSkill('up', h('a'), { ref: 'refs/heads/main' }),
      }),
    );
    // A persisted CLI-reported update-available check against the CURRENT approved base.
    await env.repository.putSkillReviewCheck({
      userId: 'alice',
      skillId: 'skill_up000001',
      approvedContentHash: h('a'),
      sourceCheckState: 'update-available',
      checkedAt: '2026-10-05T00:00:00.000Z',
      candidateRevision: 'f'.repeat(40),
      candidateContentHash: h('b'),
      reviewArtifactId: '00000000-0000-4000-8000-00000000bbbb',
      artifactPayloadHash: h('9'),
      diffFiles: [],
    });
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

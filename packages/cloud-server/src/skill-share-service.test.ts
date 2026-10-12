import { describe, expect, it } from 'vitest';

import type { CloudEnvironmentBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  handleCloudRequest,
  type CloudRequest,
} from './index.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

const skillBundle = (
  skillId: string,
  overrides: Partial<{
    remote: string;
    revision: string;
    snapshot: boolean;
    snapshotReason:
      | 'local'
      | 'unknown-source'
      | 'ambiguous-source'
      | 'modified-source'
      | 'non-portable-source';
  }> = {},
): CloudEnvironmentBundle => ({
  schemaVersion: 1,
  environment: {
    schemaVersion: 1,
    name: 'main',
    skills: [{ id: skillId, name: 'design-helper', requirement: 'required' }],
    stacks: [],
    overrides: {},
  },
  resolved: {
    schemaVersion: 1,
    skills: {
      [skillId]: {
        name: 'design-helper',
        description: 'Helps design things',
        contentHash: CONTENT_HASH,
        metadata: {
          name: 'design-helper',
          description: 'Helps design things',
          capabilities: { readFiles: true, network: false },
        },
        observedSources: [],
        restoration: overrides.snapshot
          ? {
              strategy: 'snapshot',
              contentHash: CONTENT_HASH,
              reason: overrides.snapshotReason ?? 'local',
            }
          : {
              strategy: 'reference',
              reference: {
                remote:
                  overrides.remote ?? 'https://github.com/example/design.git',
                revision: overrides.revision ?? 'a'.repeat(40),
                path: 'skills/design-helper',
                expectedContentHash: CONTENT_HASH,
              },
            },
      },
    },
  },
  importedStackVersions: [],
  snapshotRequirements: [],
  digest: `sha256:${'0'.repeat(64)}`,
});

const setup = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  let counter = 0;
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-ticket-secret',
    now: () => new Date('2026-10-11T00:00:00.000Z'),
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
      ...(options.body !== undefined ? { jsonBody: options.body } : {}),
    };
    return handleCloudRequest(service, request);
  };
  const signIn = async (
    userId: string,
    githubUsername: string,
  ): Promise<string> => {
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const userCode = (start.jsonBody as { userCode: string }).userCode;
    const deviceSecret = (start.jsonBody as { deviceSecret: string })
      .deviceSecret;
    await service.approveCliAuth({
      userCode,
      profile: { userId, githubUsername },
    });
    const token = await call('POST', 'cli/auth/token', {
      body: { deviceSecret },
    });
    return (token.jsonBody as { token: string }).token;
  };
  const pushEnvironment = async (
    token: string,
    bundle: CloudEnvironmentBundle,
  ) =>
    call('POST', 'environments/main/versions', {
      token,
      body: { bundle, expectedLatestVersionId: null },
    });
  const auth = { userId: USER_A, tokenId: 'test' };
  return { repository, service, call, signIn, pushEnvironment, auth };
};

describe('Skill sharing — eligibility (spec P10A §4, §8)', () => {
  it('fails closed: a Local-origin (snapshot) Skill is not shareable', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_local0001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(
      token,
      skillBundle(skillId, { snapshot: true, snapshotReason: 'local' }),
    );
    const status = await service.getSkillShareStatus(auth, skillId);
    expect(status.share).toEqual({
      status: 'not-shareable',
      reason:
        "This Skill comes from a local source, so STAK can't publish a safe public reference for it.",
    });
    await expect(
      service.shareSkill(auth, { skillId, slug: 'design-helper' }),
    ).rejects.toMatchObject({ code: 'publication-not-eligible' });
  });

  it('fails closed: a dirty/modified-source Skill is not shareable', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_dirty0001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(
      token,
      skillBundle(skillId, {
        snapshot: true,
        snapshotReason: 'modified-source',
      }),
    );
    const status = await service.getSkillShareStatus(auth, skillId);
    expect(status.share.status).toBe('not-shareable');
  });

  it('fails closed: a credential-bearing source URL is not shareable and cannot leak', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_creds0001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(
      token,
      skillBundle(skillId, {
        remote: 'https://user:secret-token@github.com/example/design.git',
      }),
    );
    const status = await service.getSkillShareStatus(auth, skillId);
    expect(status.share.status).toBe('not-shareable');
    if (status.share.status === 'not-shareable')
      expect(status.share.reason).not.toContain('secret-token');
    await expect(
      service.shareSkill(auth, { skillId, slug: 'design-helper' }),
    ).rejects.toMatchObject({ code: 'publication-not-eligible' });
  });

  it('shares an eligible Git-backed Skill, exposing it via the existing public-Stack read path', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_ok000001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(token, skillBundle(skillId));

    const before = await service.getSkillShareStatus(auth, skillId);
    expect(before.share.status).toBe('shareable');

    const result = await service.shareSkill(auth, {
      skillId,
      slug: 'design-helper',
    });
    expect(result.owner).toBe('temi');
    expect(result.slug).toBe('design-helper');
    expect(result.createdNew).toBe(true);

    // Public read model (reused as-is, §3): kind discriminates it as a Skill.
    const published = await service.getPublicStack('temi', 'design-helper');
    expect(published.latest?.bundle.stack.kind).toBe('skill');
    expect(published.latest?.bundle.stack.originSkillId).toBe(skillId);
    expect(published.latest?.bundle.requirements).toHaveLength(1);
    expect(published.latest?.bundle.requirements[0]?.restoration).toMatchObject(
      { strategy: 'reference' },
    );

    // Already-shared detection now reports the existing link, not "shareable" again.
    const after = await service.getSkillShareStatus(auth, skillId);
    expect(after.share).toMatchObject({
      status: 'already-shared',
      owner: 'temi',
      slug: 'design-helper',
    });
  });

  it('an upstream remote moving after publish does not alter the already-published version', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_pin00001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(
      token,
      skillBundle(skillId, { revision: 'a'.repeat(40) }),
    );
    await service.shareSkill(auth, { skillId, slug: 'design-helper' });
    const publishedBefore = await service.getPublicStack(
      'temi',
      'design-helper',
    );
    const revisionBefore =
      publishedBefore.latest?.bundle.requirements[0]?.restoration.strategy ===
      'reference'
        ? publishedBefore.latest.bundle.requirements[0].restoration.reference
            .revision
        : null;

    // Simulate the local source moving to a new revision and re-pushing the environment —
    // the already-published Skill version must stay exactly what it was at publish time.
    await pushEnvironment(
      token,
      skillBundle(skillId, { revision: 'b'.repeat(40) }),
    );
    const publishedAfter = await service.getPublicStack(
      'temi',
      'design-helper',
    );
    const revisionAfter =
      publishedAfter.latest?.bundle.requirements[0]?.restoration.strategy ===
      'reference'
        ? publishedAfter.latest.bundle.requirements[0].restoration.reference
            .revision
        : null;
    expect(revisionAfter).toBe(revisionBefore);
    expect(revisionAfter).toBe('a'.repeat(40));
  });

  it('owner/consumer identity separation: another user cannot see this Skill as "already shared" for themselves', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_sep00001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(token, skillBundle(skillId));
    await service.shareSkill(auth, { skillId, slug: 'design-helper' });

    const USER_B = '00000000-0000-4000-8000-00000000000b';
    await signIn(USER_B, 'other');
    const otherAuth = { userId: USER_B, tokenId: 'test' };
    // User B has no such Skill in their own environment at all.
    await expect(
      service.getSkillShareStatus(otherAuth, skillId),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
  });

  it('no P5a review-artifact text is ever reachable through the public read path', async () => {
    const { service, signIn, pushEnvironment, auth, repository } = setup();
    const skillId = 'skill_review001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(token, skillBundle(skillId));
    // Owner-private P5a state, keyed (userId, skillId) — must stay unreachable from any
    // public call this suite makes.
    await repository.putSkillReviewCheck({
      userId: USER_A,
      skillId,
      sourceCheckState: 'update-available',
      approvedContentHash: CONTENT_HASH,
      reviewArtifactId: '00000000-0000-4000-8000-0000000000fa',
      candidateRevision: 'c'.repeat(40),
      candidateContentHash: `sha256:${'c'.repeat(64)}`,
      artifactPayloadHash: `sha256:${'d'.repeat(64)}`,
      diffFiles: [
        { relativePath: 'SKILL.md', kind: 'modified', binary: false },
      ],
      checkedAt: '2026-10-11T00:00:00.000Z',
    });
    await service.shareSkill(auth, { skillId, slug: 'design-helper' });
    const published = await service.getPublicStack('temi', 'design-helper');
    expect(JSON.stringify(published)).not.toContain('reviewArtifact');
    expect(JSON.stringify(published)).not.toContain('SKILL.md');
  });
});

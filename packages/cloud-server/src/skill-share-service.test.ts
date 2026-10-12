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
  const auth = { userId: USER_A, tokenId: 'test' };
  // Resolves the CURRENT latest version first (spec P10 correction §3 test fix): a hardcoded
  // `expectedLatestVersionId: null` only works for the first push to `main` — a second push
  // without this would hit the real optimistic-lock conflict and silently no-op (the HTTP
  // call helper doesn't throw on a non-2xx response), which would make any "re-approve at a
  // newer revision" test pass for the wrong reason (the second push never actually happened).
  const pushEnvironment = async (
    token: string,
    bundle: CloudEnvironmentBundle,
  ) => {
    const current = await service
      .getEnvironment(auth, 'main')
      .catch(() => null);
    return call('POST', 'environments/main/versions', {
      token,
      body: {
        bundle,
        expectedLatestVersionId: current?.latest?.version.versionId ?? null,
      },
    });
  };
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

  it('a newer approved revision flips status to update-available, then re-sharing updates the published version (spec P10 correction §3)', async () => {
    const { service, signIn, pushEnvironment, auth } = setup();
    const skillId = 'skill_upd00001';
    const token = await signIn(USER_A, 'temi');
    await pushEnvironment(
      token,
      skillBundle(skillId, { revision: 'a'.repeat(40) }),
    );
    await service.shareSkill(auth, { skillId, slug: 'design-helper' });

    const stillCurrent = await service.getSkillShareStatus(auth, skillId);
    expect(stillCurrent.share.status).toBe('already-shared');

    // The user re-approves the Skill at a newer revision in `main` — this is a truthful
    // lifecycle transition, not a terminal "already-shared" forever.
    await pushEnvironment(
      token,
      skillBundle(skillId, { revision: 'b'.repeat(40) }),
    );
    const afterNewRevision = await service.getSkillShareStatus(auth, skillId);
    expect(afterNewRevision.share.status).toBe('update-available');

    const updated = await service.shareSkill(auth, {
      skillId,
      slug: 'design-helper',
    });
    expect(updated.createdNew).toBe(false); // same public Skill share, new version
    expect(updated.version.versionNumber).toBe(2);

    const republished = await service.getPublicStack('temi', 'design-helper');
    const revision =
      republished.latest?.bundle.requirements[0]?.restoration.strategy ===
      'reference'
        ? republished.latest.bundle.requirements[0].restoration.reference
            .revision
        : null;
    expect(revision).toBe('b'.repeat(40));

    const afterUpdate = await service.getSkillShareStatus(auth, skillId);
    expect(afterUpdate.share.status).toBe('already-shared');
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

  describe('unshare/re-share lifecycle (spec P10 final lifecycle pass §7/§10/§11)', () => {
    it('unshare deactivates the public share; the URL 404s; the local Skill is untouched', async () => {
      const { service, signIn, pushEnvironment, auth } = setup();
      const skillId = 'skill_unshare01';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(token, skillBundle(skillId));
      await service.shareSkill(auth, { skillId, slug: 'design-helper' });

      await service.unshareSkill(auth, skillId);

      await expect(
        service.getPublicStack('temi', 'design-helper'),
      ).rejects.toMatchObject({ code: 'public-stack-not-found' });
      const status = await service.getSkillShareStatus(auth, skillId);
      expect(status.share.status).toBe('shareable');
    });

    it('unshare is idempotent — calling it twice (or on a never-shared Skill) is a safe no-op', async () => {
      const { service, signIn, pushEnvironment, auth } = setup();
      const skillId = 'skill_unshare02';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(token, skillBundle(skillId));
      // Never shared at all.
      await expect(
        service.unshareSkill(auth, skillId),
      ).resolves.toBeUndefined();

      await service.shareSkill(auth, { skillId, slug: 'design-helper' });
      await service.unshareSkill(auth, skillId);
      await expect(
        service.unshareSkill(auth, skillId),
      ).resolves.toBeUndefined();
    });

    it('share -> unshare -> share again reactivates the SAME slug/history (identical content: no new version)', async () => {
      const { service, signIn, pushEnvironment, auth } = setup();
      const skillId = 'skill_reshare01';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(token, skillBundle(skillId));
      const first = await service.shareSkill(auth, {
        skillId,
        slug: 'design-helper',
      });
      await service.unshareSkill(auth, skillId);
      const second = await service.shareSkill(auth, {
        skillId,
        slug: 'design-helper',
      });
      expect(second.createdNew).toBe(false);
      expect(second.version.versionId).toBe(first.version.versionId);
      const published = await service.getPublicStack('temi', 'design-helper');
      expect(published.latest?.version.versionId).toBe(first.version.versionId);
    });

    it('share -> unshare -> newer approved revision -> share again creates a new version and reactivates', async () => {
      const { service, signIn, pushEnvironment, auth } = setup();
      const skillId = 'skill_reshare02';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(
        token,
        skillBundle(skillId, { revision: 'a'.repeat(40) }),
      );
      const first = await service.shareSkill(auth, {
        skillId,
        slug: 'design-helper',
      });
      await service.unshareSkill(auth, skillId);
      await pushEnvironment(
        token,
        skillBundle(skillId, { revision: 'b'.repeat(40) }),
      );
      const statusAfterRevision = await service.getSkillShareStatus(
        auth,
        skillId,
      );
      // Unpublished — reads back as 'shareable', not a stale 'already-shared'/
      // 'update-available' (§5/§9: unpublishedAt gates the status, not slug/row existence).
      expect(statusAfterRevision.share.status).toBe('shareable');
      const second = await service.shareSkill(auth, {
        skillId,
        slug: 'design-helper',
      });
      expect(second.version.versionId).not.toBe(first.version.versionId);
      const published = await service.getPublicStack('temi', 'design-helper');
      expect(
        published.latest?.bundle.requirements[0]?.restoration.strategy ===
          'reference'
          ? published.latest.bundle.requirements[0].restoration.reference
              .revision
          : null,
      ).toBe('b'.repeat(40));
    });

    it('unshare never mutates public_stack_versions; only the active-state flag changes', async () => {
      const { service, signIn, pushEnvironment, auth, repository } = setup();
      const skillId = 'skill_unshare03';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(token, skillBundle(skillId));
      const shared = await service.shareSkill(auth, {
        skillId,
        slug: 'design-helper',
      });
      const versionBefore = await repository.getPublicStackVersionById(
        shared.version.versionId,
      );
      await service.unshareSkill(auth, skillId);
      const versionAfter = await repository.getPublicStackVersionById(
        shared.version.versionId,
      );
      expect(versionAfter).toEqual(versionBefore);
      const stackRow = await repository.getPublicStackByOwner(
        USER_A,
        'design-helper',
      );
      expect(stackRow?.unpublishedAt).not.toBeNull();
    });

    it('user B cannot unshare user A Skill, and B publishing the same slug text is an independent identity', async () => {
      const { service, signIn, pushEnvironment, auth, repository } = setup();
      const skillId = 'skill_crossacct1';
      const token = await signIn(USER_A, 'temi');
      await pushEnvironment(token, skillBundle(skillId));
      await service.shareSkill(auth, { skillId, slug: 'design-helper' });

      const USER_B = '00000000-0000-4000-8000-00000000000b';
      await signIn(USER_B, 'other');
      const otherAuth = { userId: USER_B, tokenId: 'test' };
      // `pushEnvironment` is closed over USER_A's `auth` for its no-op-conflict lookup, so
      // push B's own environment directly against B's own identity instead.
      await service.commitEnvironmentVersion(otherAuth, 'main', {
        bundle: skillBundle(skillId),
        expectedLatestVersionId: null,
      });

      // B has no share of their own for this skillId — unshareSkill resolves via B's OWN
      // handle's shares only, so this is a structural no-op, never touching A's share.
      await expect(
        service.unshareSkill(otherAuth, skillId),
      ).resolves.toBeUndefined();
      const stillShared = await service.getPublicStack('temi', 'design-helper');
      expect(stillShared.latest).not.toBeNull();

      // B sharing their OWN copy of the same skillId under the same slug TEXT is not a
      // collision — public_stacks is unique per (owner_user_id, slug).
      const bShare = await service.shareSkill(otherAuth, {
        skillId,
        slug: 'design-helper',
      });
      expect(bShare.owner).toBe('other');
      const stillSharedAfter = await service.getPublicStack(
        'temi',
        'design-helper',
      );
      expect(stillSharedAfter.latest?.version.versionId).toBe(
        (await repository.getPublicStackByOwner(USER_A, 'design-helper'))
          ?.latestVersionId,
      );
    });
  });
});

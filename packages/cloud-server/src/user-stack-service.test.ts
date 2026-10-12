import { describe, expect, it } from 'vitest';

import type { CloudEnvironmentBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
} from './index.js';

const USER_A = '00000000-0000-4000-8000-00000000d1a1';
const USER_B = '00000000-0000-4000-8000-00000000d1b2';
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;
const CONTENT_HASH_2 = `sha256:${'b'.repeat(64)}`;
const CONTENT_HASH_3 = `sha256:${'c'.repeat(64)}`;
const SKILL_ID = 'skill_design0001';
const SKILL_ID_2 = 'skill_notes00001';
const SKILL_ID_3 = 'skill_extra00001';

const setup = () => {
  const repository = createInMemoryRepository();
  const service = createCloudService({
    repository,
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'user-stack-secret',
    now: () => new Date('2026-10-11T00:00:00.000Z'),
  });
  const auth = { userId: USER_A, tokenId: 'test' };
  const authB = { userId: USER_B, tokenId: 'test-b' };
  return { service, repository, auth, authB };
};

const pushMainFor = async (
  service: ReturnType<typeof createCloudService>,
  userId: string,
  skills: Record<
    string,
    {
      name: string;
      contentHash: string;
      strategy: 'reference' | 'snapshot';
      remote?: string;
    }
  >,
) => {
  const bundle: CloudEnvironmentBundle = {
    schemaVersion: 1,
    environment: {
      schemaVersion: 1,
      name: 'main',
      skills: Object.entries(skills).map(([id, s]) => ({
        id,
        name: s.name,
        requirement: 'required' as const,
      })),
      stacks: [],
      overrides: {},
    },
    resolved: {
      schemaVersion: 1,
      skills: Object.fromEntries(
        Object.entries(skills).map(([id, s]) => [
          id,
          {
            name: s.name,
            description: `${s.name} description`,
            contentHash: s.contentHash,
            metadata: { name: s.name, description: `${s.name} description` },
            observedSources: [],
            restoration:
              s.strategy === 'reference'
                ? {
                    strategy: 'reference' as const,
                    reference: {
                      remote: s.remote ?? 'https://example.com/example/x.git',
                      revision: 'a'.repeat(40),
                      path: `skills/${s.name}`,
                      expectedContentHash: s.contentHash,
                    },
                  }
                : {
                    strategy: 'snapshot' as const,
                    contentHash: s.contentHash,
                    reason: 'local' as const,
                  },
          },
        ]),
      ),
    },
    importedStackVersions: [],
    snapshotRequirements: [],
    digest: `sha256:${'0'.repeat(64)}`,
  };
  await service.commitEnvironmentVersion({ userId, tokenId: 'test' }, 'main', {
    bundle,
    expectedLatestVersionId: null,
  });
};

const pushMain = (
  service: ReturnType<typeof createCloudService>,
  skills: Record<
    string,
    {
      name: string;
      contentHash: string;
      strategy: 'reference' | 'snapshot';
      remote?: string;
    }
  >,
) => pushMainFor(service, USER_A, skills);

describe('Named Stacks (P10B §11-15)', () => {
  it('creates a named Stack from approved Skills and lists it', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      description: 'Frontend tools',
      skillIds: [SKILL_ID],
    });
    expect(created.version.versionNumber).toBe(1);

    const list = await service.listUserStacks(auth);
    expect(list.stacks).toHaveLength(1);
    expect(list.stacks[0]).toMatchObject({
      name: 'frontend',
      skillCount: 1,
      versionNumber: 1,
    });
  });

  it('rejects a duplicate Stack name', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID],
    });
    await expect(
      service.createUserStack(auth, { name: 'frontend', skillIds: [SKILL_ID] }),
    ).rejects.toMatchObject({ code: 'user-stack-name-conflict' });
  });

  it('editing a named Stack never touches `main`', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
      [SKILL_ID_2]: {
        name: 'notes',
        contentHash: CONTENT_HASH_2,
        strategy: 'reference',
      },
    });
    const mainBefore = await service.getEnvironment(auth, 'main');

    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID],
    });
    await service.updateUserStack(auth, {
      stackId: created.stackId,
      expectedLatestVersionId: created.version.versionId,
      skills: [
        { skillId: SKILL_ID, paused: false },
        { skillId: SKILL_ID_2, paused: true },
      ],
    });

    const mainAfter = await service.getEnvironment(auth, 'main');
    expect(mainAfter.latest?.version.versionId).toBe(
      mainBefore.latest?.version.versionId,
    );

    const detail = await service.getUserStack(auth, created.stackId);
    expect(detail.skills).toHaveLength(2);
    expect(detail.skills.find((s) => s.skillId === SKILL_ID_2)?.paused).toBe(
      true,
    );
    expect(detail.version?.versionNumber).toBe(2);
  });

  it('rename is a pure rename — no new version, rejects collision', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    const a = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID],
    });
    await service.createUserStack(auth, {
      name: 'mobile',
      skillIds: [SKILL_ID],
    });

    const renamed = await service.updateUserStack(auth, {
      stackId: a.stackId,
      expectedLatestVersionId: a.version.versionId,
      name: 'web',
    });
    expect(renamed.name).toBe('web');
    expect(renamed.version?.versionNumber).toBe(1); // unchanged — rename is not a new version

    await expect(
      service.updateUserStack(auth, {
        stackId: a.stackId,
        expectedLatestVersionId: a.version.versionId,
        name: 'mobile',
      }),
    ).rejects.toMatchObject({ code: 'user-stack-name-conflict' });
  });

  it('publishing fails closed when any Skill in the Stack is ineligible (never partial)', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
      [SKILL_ID_2]: {
        name: 'local-notes',
        contentHash: CONTENT_HASH_2,
        strategy: 'snapshot',
      },
    });
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID, SKILL_ID_2],
    });
    await expect(
      service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      }),
    ).rejects.toMatchObject({ code: 'publication-not-eligible' });
  });

  it('publishes an all-eligible named Stack via the existing public-Stack pipeline', async () => {
    const { service, repository, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID],
    });
    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'frontend',
    });
    expect(result.createdNew).toBe(true);
    const published = await service.getPublicStack(result.owner, 'frontend');
    expect(published.latest?.bundle.stack.kind).toBe('stack');
    expect(published.latest?.bundle.requirements).toHaveLength(1);
  });

  it('rejects "main" as a named-Stack name, even after normalization', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    for (const candidate of ['main', 'MAIN', ' Main ']) {
      await expect(
        service.createUserStack(auth, {
          name: candidate,
          skillIds: [SKILL_ID],
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    }
  });

  it('canonicalizes name case/whitespace to one identity (rename collision after normalization)', async () => {
    const { service, auth } = setup();
    await pushMain(service, {
      [SKILL_ID]: {
        name: 'design',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
    });
    const a = await service.createUserStack(auth, {
      name: ' Frontend ',
      skillIds: [SKILL_ID],
    });
    expect(a.name).toBe('frontend');

    const b = await service.createUserStack(auth, {
      name: 'mobile',
      skillIds: [SKILL_ID],
    });
    // "Mobile" canonicalizes to the same identity as the existing "mobile" Stack.
    await expect(
      service.updateUserStack(auth, {
        stackId: a.stackId,
        expectedLatestVersionId: a.version.versionId,
        name: ' Mobile ',
      }),
    ).rejects.toMatchObject({ code: 'user-stack-name-conflict' });
    expect(b.name).toBe('mobile');
  });

  describe('republish lifecycle (spec P10 correction §2/§12)', () => {
    it('first publish creates version 1', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      const result = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(result.createdNew).toBe(true);
      expect(result.version.versionNumber).toBe(1);
    });

    it('republish after editing the Stack commits a new version, resolved server-side', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
        [SKILL_ID_2]: {
          name: 'notes',
          contentHash: CONTENT_HASH_2,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      const first = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(first.version.versionNumber).toBe(1);

      await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        skills: [
          { skillId: SKILL_ID, paused: false },
          { skillId: SKILL_ID_2, paused: false },
        ],
      });

      // The caller supplies no version id at all — the server resolves the current latest
      // itself. Before the fix this always sent `expectedLatestVersionId: null` and failed.
      const second = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(second.createdNew).toBe(false); // same public Stack, new version
      expect(second.version.versionNumber).toBe(2);

      const published = await service.getPublicStack(first.owner, 'frontend');
      expect(published.latest?.bundle.requirements).toHaveLength(2);
    });

    it('identical-content republish is a clean no-op, not a meaningless duplicate version', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      const first = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      const second = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(second.createdNew).toBe(false);
      expect(second.version.versionNumber).toBe(first.version.versionNumber);
    });

    it('concurrent stale republish fails safely for the loser, succeeds for the winner', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      // Settle handle resolution and v1 sequentially first, so the race below is actually
      // about the version-commit conflict, not an unrelated handle-reservation race.
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      // Two callers racing to republish the SAME Stack from the SAME base version — both
      // resolve "current latest = v1" before either commits v2.
      const outcomes = await Promise.allSettled([
        service.publishUserStack(auth, {
          stackId: created.stackId,
          slug: 'frontend',
          displayName: 'Frontend A',
        }),
        service.publishUserStack(auth, {
          stackId: created.stackId,
          slug: 'frontend',
          displayName: 'Frontend B',
        }),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'public-stack-conflict',
      });
    });

    it('republish revalidates CURRENT eligibility — a Local Skill added after v1 blocks v2', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
        [SKILL_ID_3]: {
          name: 'local-only',
          contentHash: CONTENT_HASH_3,
          strategy: 'snapshot',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      const first = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(first.version.versionNumber).toBe(1);

      await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        skills: [
          { skillId: SKILL_ID, paused: false },
          { skillId: SKILL_ID_3, paused: false },
        ],
      });

      await expect(
        service.publishUserStack(auth, {
          stackId: created.stackId,
          slug: 'frontend',
        }),
      ).rejects.toMatchObject({ code: 'publication-not-eligible' });

      // v1 remains exactly what it was — republish failing never touches the already-
      // published, immutable version.
      const published = await service.getPublicStack(first.owner, 'frontend');
      expect(published.latest?.version.versionNumber).toBe(1);
    });

    it('getUserStackPublicationStatus reflects private / published / changed-since-published', async () => {
      const { service, repository, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
        [SKILL_ID_2]: {
          name: 'notes',
          contentHash: CONTENT_HASH_2,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });

      const beforePublish = await service.getUserStackPublicationStatus(
        auth,
        created.stackId,
      );
      expect(beforePublish.publication.status).toBe('private');

      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      const afterPublish = await service.getUserStackPublicationStatus(
        auth,
        created.stackId,
      );
      expect(afterPublish.publication.status).toBe('published');

      await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        skills: [
          { skillId: SKILL_ID, paused: false },
          { skillId: SKILL_ID_2, paused: false },
        ],
      });
      const afterEdit = await service.getUserStackPublicationStatus(
        auth,
        created.stackId,
      );
      expect(afterEdit.publication.status).toBe('changed-since-published');
    });
  });

  describe('cross-account isolation (spec P10 correction §9)', () => {
    it('user B cannot list, fetch, rename, version-read, commit, or publish user A Stacks', async () => {
      const { service, repository, auth, authB } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMainFor(service, USER_A, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });

      // list
      const listB = await service.listUserStacks(authB);
      expect(listB.stacks).toHaveLength(0);

      // fetch detail
      await expect(
        service.getUserStack(authB, created.stackId),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // fetch by name
      await expect(
        service.getUserStackByName(authB, 'frontend'),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // rename
      await expect(
        service.updateUserStack(authB, {
          stackId: created.stackId,
          expectedLatestVersionId: created.version.versionId,
          name: 'stolen',
        }),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // commit a version / alter latest-version pointer (via composition edit)
      await expect(
        service.updateUserStack(authB, {
          stackId: created.stackId,
          expectedLatestVersionId: created.version.versionId,
          skills: [{ skillId: SKILL_ID, paused: true }],
        }),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // publish through someone else's Stack
      await expect(
        service.publishUserStack(authB, {
          stackId: created.stackId,
          slug: 'stolen',
        }),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // publication status
      await expect(
        service.getUserStackPublicationStatus(authB, created.stackId),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // main remained untouched throughout
      const mainA = await service.getEnvironment(auth, 'main');
      expect(mainA.latest).not.toBeNull();
    });

    it('a guessed/known version id cannot cross the ownership boundary (owner-scoped reads, §8)', async () => {
      const { service, repository, auth } = setup();
      await pushMainFor(service, USER_A, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      const created = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      // User B somehow learns user A's version id (e.g. from a log) — direct repository-level
      // owner-scoped lookup must still refuse it.
      const versionId = created.version.versionId;
      const crossAccountRead = await repository.getUserStackVersion(
        USER_B,
        versionId,
      );
      expect(crossAccountRead).toBeNull();
      const ownerRead = await repository.getUserStackVersion(USER_A, versionId);
      expect(ownerRead).not.toBeNull();
    });
  });
});

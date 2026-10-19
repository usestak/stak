import { describe, expect, it } from 'vitest';

import type { CloudEnvironmentBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  handleCloudRequest,
  type CloudRequest,
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
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'user-stack-secret',
    now: () => new Date('2026-10-11T00:00:00.000Z'),
  });
  const auth = { userId: USER_A, tokenId: 'test' };
  const authB = { userId: USER_B, tokenId: 'test-b' };
  return { service, repository, blobStore, auth, authB };
};

const pushMainFor = async (
  blobStore: ReturnType<typeof createInMemoryBlobStore>,
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
  // Snapshot-first publication: a Git-backed (`strategy: 'reference'`) Skill now also
  // publishes through its immutable snapshot, so `publishUserStack` requires real bytes for
  // it too. Seed a placeholder under the owner's scope, mirroring what a real `stak push`
  // (or an ordinary checkout already cached in the local Store) would have produced — no
  // test here asserts the exact bytes of a Git-backed snapshot, only its presence/shape.
  // Snapshot-strategy skills are deliberately left unseeded: tests that need pushed bytes for
  // them already call `blobStore.put` explicitly, and tests proving the "not pushed yet"
  // failure path rely on this function NOT seeding them.
  for (const s of Object.values(skills))
    if (s.strategy === 'reference')
      await blobStore.put(userId, s.contentHash, new Uint8Array([1, 2, 3]));
};

const pushMain = (
  service: ReturnType<typeof createCloudService>,
  blobStore: ReturnType<typeof createInMemoryBlobStore>,
  skills: Record<
    string,
    {
      name: string;
      contentHash: string;
      strategy: 'reference' | 'snapshot';
      remote?: string;
    }
  >,
) => pushMainFor(blobStore, service, USER_A, skills);

describe('Named Stacks (P10B §11-15)', () => {
  it('creates a named Stack from approved Skills and lists it', async () => {
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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

  it("rejects publishing a Stack when one Skill's content was never pushed, naming it in the combined error", async () => {
    // Snapshot-first parity for named-Stack publish (this task): a snapshot-strategy Skill
    // always passes `assessSkillShareEligibility`, but its bytes still have to actually be
    // in Cloud (`stak push`) before it can be published. design-pushed is auto-seeded by
    // `pushMain`'s reference-strategy placeholder; local-unpushed is deliberately left
    // unseeded.
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'design-pushed',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
      [SKILL_ID_2]: {
        name: 'local-unpushed',
        contentHash: CONTENT_HASH_2,
        strategy: 'snapshot',
      },
    });
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID, SKILL_ID_2],
    });
    const error = await service
      .publishUserStack(auth, { stackId: created.stackId, slug: 'frontend' })
      .catch((e) => e);
    expect(error).toMatchObject({ code: 'publication-not-eligible' });
    expect(error.message).toContain('local-unpushed');
    expect(error.message).toContain('run `stak push` first');
    expect(error.message).not.toContain('design-pushed (');
  });

  it('rejects publishing when multiple Skills are missing snapshots, naming all of them in one combined error', async () => {
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'local-unpushed-a',
        contentHash: CONTENT_HASH,
        strategy: 'snapshot',
      },
      [SKILL_ID_2]: {
        name: 'local-unpushed-b',
        contentHash: CONTENT_HASH_2,
        strategy: 'snapshot',
      },
    });
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID, SKILL_ID_2],
    });
    const error = await service
      .publishUserStack(auth, { stackId: created.stackId, slug: 'frontend' })
      .catch((e) => e);
    expect(error).toMatchObject({ code: 'publication-not-eligible' });
    expect(error.message).toContain('2 Skill(s)');
    expect(error.message).toContain('local-unpushed-a');
    expect(error.message).toContain('local-unpushed-b');
  });

  it("publishes successfully when every Skill's content has been pushed, all as snapshot-strategy", async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'design-pushed',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
      [SKILL_ID_2]: {
        name: 'local-pushed',
        contentHash: CONTENT_HASH_2,
        strategy: 'snapshot',
      },
    });
    // Equivalent to `stak push`: the local-snapshot Skill's bytes exist in Cloud too (the
    // reference-strategy Skill's are already auto-seeded by `pushMain`).
    await blobStore.put(USER_A, CONTENT_HASH_2, new Uint8Array([4, 5, 6]));
    const created = await service.createUserStack(auth, {
      name: 'frontend',
      skillIds: [SKILL_ID, SKILL_ID_2],
    });
    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'frontend',
    });
    expect(result.createdNew).toBe(true);
    const published = await service.getPublicStack(result.owner, 'frontend');
    expect(published.latest?.bundle.requirements).toHaveLength(2);
    for (const requirement of published.latest?.bundle.requirements ?? [])
      expect(requirement.restoration.strategy).toBe('snapshot');
  });

  it('creates no public version row when publication is rejected for a missing snapshot (no partial publish)', async () => {
    const { service, repository, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'design-pushed',
        contentHash: CONTENT_HASH,
        strategy: 'reference',
      },
      [SKILL_ID_2]: {
        name: 'local-unpushed',
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
        slug: 'no-partial',
      }),
    ).rejects.toThrow();
    const existing = await repository.getPublicStackByOwner(
      USER_A,
      'no-partial',
    );
    expect(existing).toBeNull();
  });

  it('publishes an all-eligible named Stack via the existing public-Stack pipeline', async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
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
    // Regression: the canonical browser share URL is `owner/slug`, never the
    // `@owner/slug` CLI locator form — the two are deliberately different grammars.
    expect(result.url).toBe('http://localhost:3000/alice/frontend');
    expect(result.url).not.toContain('@');
  });

  it('Hybrid Public Skill Portability: an all-local-snapshot named Stack publishes, and the snapshot is fetchable anonymously by content hash', async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'local-notes',
        contentHash: CONTENT_HASH,
        strategy: 'snapshot',
      },
    });
    // Equivalent to `stak push`: the owner's content bytes already exist in Cloud.
    await blobStore.put(USER_A, CONTENT_HASH, new Uint8Array([9, 8, 7]));
    const created = await service.createUserStack(auth, {
      name: 'notes',
      skillIds: [SKILL_ID],
    });
    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'notes',
    });
    const published = await service.getPublicStack(result.owner, 'notes');
    expect(published.latest?.bundle.requirements[0]?.restoration).toEqual({
      strategy: 'snapshot',
      contentHash: CONTENT_HASH,
    });

    const versionNumber = published.latest?.version.versionNumber ?? 0;
    const request: CloudRequest = {
      method: 'GET',
      path: `/api/v1/stacks/${result.owner}/notes/versions/${versionNumber}/snapshots/${CONTENT_HASH}`,
      headers: {},
    };
    const response = await handleCloudRequest(service, request);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.binaryBody).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("Hybrid Public Skill Portability authorization matrix: a contentHash that exists in the owner's private blob store but was never part of any published bundle is not retrievable (guessing a hash cannot expose private content)", async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'local-notes',
        contentHash: CONTENT_HASH,
        strategy: 'snapshot',
      },
    });
    await blobStore.put(USER_A, CONTENT_HASH, new Uint8Array([9, 8, 7]));
    const created = await service.createUserStack(auth, {
      name: 'notes',
      skillIds: [SKILL_ID],
    });
    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'notes',
    });
    const published = await service.getPublicStack(result.owner, 'notes');
    const versionNumber = published.latest?.version.versionNumber ?? 0;

    // CONTENT_HASH_2 was never pushed, never published, never referenced by any bundle.
    await expect(
      service.getPublicSkillSnapshot(
        result.owner,
        'notes',
        versionNumber,
        CONTENT_HASH_2,
      ),
    ).rejects.toMatchObject({ code: 'public-stack-not-found' });
  });

  it("Hybrid Public Skill Portability authorization matrix: a never-published named Stack's snapshot is inaccessible, and an unpublished Stack's snapshot becomes inaccessible", async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'local-notes',
        contentHash: CONTENT_HASH,
        strategy: 'snapshot',
      },
    });
    await blobStore.put(USER_A, CONTENT_HASH, new Uint8Array([9, 8, 7]));
    const created = await service.createUserStack(auth, {
      name: 'draft-notes',
      skillIds: [SKILL_ID],
    });
    // Never published — guessing a plausible owner/slug/version/hash combination 404s,
    // same as any other unknown route; no public Stack row exists for this slug at all.
    await expect(
      service.getPublicSkillSnapshot('alice', 'draft-notes', 1, CONTENT_HASH),
    ).rejects.toMatchObject({ code: 'public-stack-not-found' });

    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'draft-notes',
    });
    const published = await service.getPublicStack(result.owner, 'draft-notes');
    const versionNumber = published.latest?.version.versionNumber ?? 0;
    await expect(
      service.getPublicSkillSnapshot(
        result.owner,
        'draft-notes',
        versionNumber,
        CONTENT_HASH,
      ),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    await service.unpublishUserStack(auth, created.stackId);
    await expect(
      service.getPublicSkillSnapshot(
        result.owner,
        'draft-notes',
        versionNumber,
        CONTENT_HASH,
      ),
    ).rejects.toMatchObject({ code: 'public-stack-not-found' });
  });

  it('prevents cached access after unpublish: a published snapshot 200s with Cache-Control: no-store, and the same URL 404s with no-store (not a cacheable policy) after unpublish', async () => {
    const { service, repository, blobStore, auth } = setup();
    await repository.upsertProfile({ userId: USER_A, githubUsername: 'alice' });
    await pushMain(service, blobStore, {
      [SKILL_ID]: {
        name: 'local-notes',
        contentHash: CONTENT_HASH,
        strategy: 'snapshot',
      },
    });
    await blobStore.put(USER_A, CONTENT_HASH, new Uint8Array([9, 8, 7]));
    const created = await service.createUserStack(auth, {
      name: 'notes',
      skillIds: [SKILL_ID],
    });
    const result = await service.publishUserStack(auth, {
      stackId: created.stackId,
      slug: 'notes',
    });
    const published = await service.getPublicStack(result.owner, 'notes');
    const versionNumber = published.latest?.version.versionNumber ?? 0;
    const snapshotPath = `/api/v1/stacks/${result.owner}/notes/versions/${versionNumber}/snapshots/${CONTENT_HASH}`;

    const beforeUnpublish = await handleCloudRequest(service, {
      method: 'GET',
      path: snapshotPath,
      headers: {},
    });
    expect(beforeUnpublish.status).toBe(200);
    expect(beforeUnpublish.headers['cache-control']).toBe('no-store');

    await service.unpublishUserStack(auth, created.stackId);

    // Direct existence of the underlying blob must not bypass the publication check: the
    // same URL that 200'd a moment ago now 404s, and that 404 is marked no-store too, so a
    // CDN that cached the earlier 200 is never load-bearing for either response.
    const afterUnpublish = await handleCloudRequest(service, {
      method: 'GET',
      path: snapshotPath,
      headers: {},
    });
    expect(afterUnpublish.status).toBe(404);
    expect(afterUnpublish.headers['cache-control']).toBe('no-store');
  });

  it('rejects "main" as a named-Stack name, even after normalization', async () => {
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
    const { service, blobStore, auth } = setup();
    await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      if (afterPublish.publication.status === 'published') {
        // Regression: canonical browser share URL, never the `@owner/slug` CLI locator.
        expect(afterPublish.publication.url).toBe(
          'http://localhost:3000/alice/frontend',
        );
        expect(afterPublish.publication.url).not.toContain('@');
      }

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
      // Republish/unpublished-changes state (web UX item H): the backend already exposes
      // enough to show "Unpublished changes" + a Republish action without inventing any
      // client-side dirty-state tracking.
      if (afterEdit.publication.status === 'changed-since-published') {
        expect(afterEdit.publication.url).not.toContain('@');
      }
    });
  });

  describe('cross-account isolation (spec P10 correction §9)', () => {
    it('user B cannot list, fetch, rename, version-read, commit, or publish user A Stacks', async () => {
      const { service, repository, blobStore, auth, authB } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMainFor(blobStore, service, USER_A, {
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
      const { service, repository, blobStore, auth } = setup();
      await pushMainFor(blobStore, service, USER_A, {
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

  describe('unpublish/reactivate lifecycle (spec P10 final lifecycle pass §8/§9/§10/§11/§12)', () => {
    it('unpublish deactivates the public share; the URL 404s; the private Stack and main are untouched', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      const mainBefore = await service.getEnvironment(auth, 'main');

      await service.unpublishUserStack(auth, created.stackId);

      await expect(
        service.getPublicStack('alice', 'frontend'),
      ).rejects.toMatchObject({ code: 'public-stack-not-found' });
      const status = await service.getUserStackPublicationStatus(
        auth,
        created.stackId,
      );
      expect(status.publication.status).toBe('private');
      const stillPrivate = await service.getUserStack(auth, created.stackId);
      expect(stillPrivate.skills).toHaveLength(1); // private Stack untouched
      const mainAfter = await service.getEnvironment(auth, 'main');
      expect(mainAfter.latest?.version.versionId).toBe(
        mainBefore.latest?.version.versionId,
      );
    });

    it('unpublish is idempotent — calling it twice is a safe no-op', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      await service.unpublishUserStack(auth, created.stackId);
      await expect(
        service.unpublishUserStack(auth, created.stackId),
      ).resolves.toMatchObject({ publication: { status: 'private' } });
    });

    it('publish -> unpublish -> publish again reactivates the SAME identity/slug and preserves history (identical content: no new version)', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.unpublishUserStack(auth, created.stackId);
      const second = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(second.createdNew).toBe(false); // reactivation, not a new version
      expect(second.version.versionId).toBe(first.version.versionId);
      const published = await service.getPublicStack('alice', 'frontend');
      expect(published.latest?.version.versionId).toBe(first.version.versionId);
    });

    it('publish -> unpublish -> edit composition -> publish again creates a new version and reactivates', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.unpublishUserStack(auth, created.stackId);
      const edited = await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        skills: [{ skillId: SKILL_ID }, { skillId: SKILL_ID_2 }],
      });
      const second = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(second.createdNew).toBe(false); // the public_stacks row itself is not new
      expect(second.version.versionId).not.toBe(first.version.versionId);
      const published = await service.getPublicStack('alice', 'frontend');
      expect(published.latest?.bundle.requirements).toHaveLength(2);
      expect(edited.version?.versionNumber).toBe(2);
    });

    it('unpublishing does not release the slug for a DIFFERENT Stack in the same account', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const stackA = await service.createUserStack(auth, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      await service.publishUserStack(auth, {
        stackId: stackA.stackId,
        slug: 'frontend',
      });
      await service.unpublishUserStack(auth, stackA.stackId);

      const stackB = await service.createUserStack(auth, {
        name: 'web',
        skillIds: [SKILL_ID_2],
      });
      await expect(
        service.publishUserStack(auth, {
          stackId: stackB.stackId,
          slug: 'frontend',
        }),
      ).rejects.toMatchObject({ code: 'public-slug-taken' });
    });

    it('slug stability: a Stack already published cannot silently change its public slug', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      await expect(
        service.publishUserStack(auth, {
          stackId: created.stackId,
          slug: 'web',
        }),
      ).rejects.toMatchObject({ code: 'public-slug-taken' });
    });

    it('renaming the private Stack after publish does not change the public slug; republish after unpublish+rename keeps the original slug', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        name: 'web',
      });
      const statusAfterRename = await service.getUserStackPublicationStatus(
        auth,
        created.stackId,
      );
      expect(statusAfterRename.publication).toMatchObject({ slug: 'frontend' });

      await service.unpublishUserStack(auth, created.stackId);
      const republished = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      expect(republished.slug).toBe('frontend');
    });

    it('unpublish never mutates public_stack_versions rows; only the active-state flag changes', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      const published = await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      const versionBefore = await repository.getPublicStackVersionById(
        published.version.versionId,
      );
      await service.unpublishUserStack(auth, created.stackId);
      const versionAfter = await repository.getPublicStackVersionById(
        published.version.versionId,
      );
      expect(versionAfter).toEqual(versionBefore);
      const stackRow = await repository.getPublicStackByOwner(
        USER_A,
        'frontend',
      );
      expect(stackRow?.latestVersionId).toBe(published.version.versionId);
      expect(stackRow?.unpublishedAt).not.toBeNull();
    });

    it('republish after unpublish still revalidates CURRENT eligibility', async () => {
      const { service, repository, blobStore, auth } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await pushMain(service, blobStore, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });
      await service.unpublishUserStack(auth, created.stackId);
      await service.updateUserStack(auth, {
        stackId: created.stackId,
        expectedLatestVersionId: created.version.versionId,
        skills: [{ skillId: SKILL_ID }, { skillId: SKILL_ID_3 }],
      });
      await expect(
        service.publishUserStack(auth, {
          stackId: created.stackId,
          slug: 'frontend',
        }),
      ).rejects.toMatchObject({ code: 'publication-not-eligible' });
    });

    it('user B cannot unpublish, reactivate, or publish onto user A public identity', async () => {
      const { service, repository, blobStore, auth, authB } = setup();
      await repository.upsertProfile({
        userId: USER_A,
        githubUsername: 'alice',
      });
      await repository.upsertProfile({ userId: USER_B, githubUsername: 'bob' });
      await pushMain(service, blobStore, {
        [SKILL_ID]: {
          name: 'design',
          contentHash: CONTENT_HASH,
          strategy: 'reference',
        },
      });
      await pushMainFor(blobStore, service, USER_B, {
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
      await service.publishUserStack(auth, {
        stackId: created.stackId,
        slug: 'frontend',
      });

      // B has no Stack of their own named/pointing at this — unpublishUserStack is scoped to
      // B's OWN owned Stacks, so B cannot even address A's stackId.
      await expect(
        service.unpublishUserStack(authB, created.stackId),
      ).rejects.toMatchObject({ code: 'user-stack-not-found' });

      // B publishing their OWN Stack under the same slug TEXT is not a collision at all —
      // public_stacks is unique per (owner_user_id, slug), so @alice/frontend and
      // @bob/frontend are structurally independent identities. This proves isolation, not a
      // guard: B's publish succeeds, and it never touches A's row/version history.
      const bStack = await service.createUserStack(authB, {
        name: 'frontend',
        skillIds: [SKILL_ID],
      });
      const bPublished = await service.publishUserStack(authB, {
        stackId: bStack.stackId,
        slug: 'frontend',
      });
      expect(bPublished.owner).toBe('bob');

      // A's share remains fully active and untouched throughout.
      const stillPublished = await service.getPublicStack('alice', 'frontend');
      expect(stillPublished.latest).not.toBeNull();

      // Even the raw primitive (scoped purely by caller's own derived userId + slug) cannot
      // reach A's row: B's own userId never matches A's row, so this is a structural no-op.
      await service.unpublishPublicStack(authB, { slug: 'frontend' });
      const stillPublishedAfter = await service.getPublicStack(
        'alice',
        'frontend',
      );
      expect(stillPublishedAfter.latest).not.toBeNull();
    });
  });
});

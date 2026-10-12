import { describe, expect, it } from 'vitest';

import type { CloudEnvironmentBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
} from './index.js';

const USER_A = '00000000-0000-4000-8000-00000000d1a1';
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;
const CONTENT_HASH_2 = `sha256:${'b'.repeat(64)}`;
const SKILL_ID = 'skill_design0001';
const SKILL_ID_2 = 'skill_notes00001';

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
  return { service, repository, auth };
};

const pushMain = async (
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
  await service.commitEnvironmentVersion(
    { userId: USER_A, tokenId: 'test' },
    'main',
    {
      bundle,
      expectedLatestVersionId: null,
    },
  );
};

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
});

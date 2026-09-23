import { CloudServiceError } from '@stack/cloud-server';
import { describe, expect, it, vi } from 'vitest';

import {
  DashboardLoadError,
  getUserStack,
  listUserStacks,
  type DashboardService,
} from './dashboard.js';

type Skill = { name: string; description?: string };

const environment = (
  skills: Skill[],
  version = 1,
  createdAt = '2026-09-22T10:00:00.000Z',
) => ({
  environmentId: 'env-1',
  name: 'main',
  latest: {
    version: {
      versionId: 'v-1',
      versionNumber: version,
      digest: `sha256:${'a'.repeat(64)}`,
      createdAt,
    },
    bundle: {
      resolved: {
        skills: Object.fromEntries(
          skills.map((skill, index) => [
            `skill_${String(index).padStart(8, '0')}`,
            { name: skill.name, description: skill.description ?? skill.name },
          ]),
        ),
      },
    },
  },
});

const serviceReturning = (value: unknown) =>
  ({
    getEnvironment: vi.fn(async () => value),
  }) as unknown as DashboardService & {
    getEnvironment: ReturnType<typeof vi.fn>;
  };

const notFoundService = () =>
  ({
    getEnvironment: vi.fn(async () => {
      throw new CloudServiceError(
        'remote-environment-not-found',
        404,
        'No cloud Environment named main.',
      );
    }),
  }) as unknown as DashboardService;

const failingService = () =>
  ({
    getEnvironment: vi.fn(async () => {
      throw new Error('boom');
    }),
  }) as unknown as DashboardService;

describe('listUserStacks', () => {
  it('summarizes a pushed main Stack', async () => {
    const service = serviceReturning(
      environment([{ name: 'animate' }, { name: 'copywriting' }], 1),
    );
    const stacks = await listUserStacks('user-1', service);
    expect(stacks).toEqual([
      {
        slug: 'main',
        name: 'main',
        skillCount: 2,
        cloudVersion: 1,
        updatedAt: '2026-09-22T10:00:00.000Z',
      },
    ]);
    // Isolation: the query is scoped to the signed-in user's id.
    expect(service.getEnvironment).toHaveBeenCalledWith(
      { userId: 'user-1', tokenId: 'web-session' },
      'main',
    );
  });

  it('returns an empty list when nothing has been pushed', async () => {
    expect(await listUserStacks('user-1', notFoundService())).toEqual([]);
  });

  it('handles an environment with no version yet', async () => {
    const service = serviceReturning({
      environmentId: 'env-1',
      name: 'main',
      latest: null,
    });
    expect(await listUserStacks('user-1', service)).toEqual([
      {
        slug: 'main',
        name: 'main',
        skillCount: 0,
        cloudVersion: null,
        updatedAt: null,
      },
    ]);
  });

  it('raises a friendly load error on a real failure', async () => {
    await expect(
      listUserStacks('user-1', failingService()),
    ).rejects.toBeInstanceOf(DashboardLoadError);
  });
});

describe('getUserStack', () => {
  it('returns detail with an alphabetized Skills list, count, and version', async () => {
    const service = serviceReturning(
      environment(
        [
          { name: 'react', description: 'React patterns' },
          { name: 'animate' },
          { name: 'copywriting' },
        ],
        3,
        '2026-09-22T08:00:00.000Z',
      ),
    );
    const detail = await getUserStack('user-1', 'main', service);
    expect(detail).not.toBeNull();
    expect(detail?.skillCount).toBe(3);
    expect(detail?.cloudVersion).toBe(3);
    expect(detail?.updatedAt).toBe('2026-09-22T08:00:00.000Z');
    expect(detail?.skills.map((skill) => skill.name)).toEqual([
      'animate',
      'copywriting',
      'react',
    ]);
    expect(detail?.skills[2]?.description).toBe('React patterns');
  });

  it('returns null for an unknown slug', async () => {
    const service = serviceReturning(environment([{ name: 'x' }]));
    expect(await getUserStack('user-1', 'not-main', service)).toBeNull();
  });

  it('returns null when the Stack does not exist', async () => {
    expect(await getUserStack('user-1', 'main', notFoundService())).toBeNull();
  });

  it('raises a friendly load error on a real failure', async () => {
    await expect(
      getUserStack('user-1', 'main', failingService()),
    ).rejects.toBeInstanceOf(DashboardLoadError);
  });
});

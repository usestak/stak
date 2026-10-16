import { describe, expect, it } from 'vitest';

import type { GetPublicStackResponse } from '@stack/spec';
import {
  CloudBundleInvalidError,
  PublicStackNotFoundError,
} from '@stack/cloud-client';

import { buildPublicStackBundle } from './public-stack.js';
import { resolvePublicStackSource } from './remote-source.js';

const contentHash = `sha256:${'a'.repeat(64)}`;
const revision = 'a'.repeat(40);

const bundle = buildPublicStackBundle({
  schemaVersion: 1,
  name: 'frontend',
  description: 'Frontend Stack',
  versionHash:
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  requirements: [
    {
      id: 'req_design01',
      name: 'design',
      requirement: 'required',
      contentHash,
      metadata: { name: 'design', description: 'd' },
      restoration: {
        strategy: 'reference',
        reference: {
          remote: 'https://github.com/example/design.git',
          revision,
          path: 'skills/design',
          expectedContentHash: contentHash,
        },
      },
      observedSources: [
        {
          type: 'git',
          remote: 'https://github.com/example/design.git',
          revision,
          path: 'skills/design',
          clean: true,
        },
      ],
      originStackName: 'frontend',
    },
  ],
  inheritedStacks: [],
  skippedOptional: [],
});

const response = (
  overrides: Partial<GetPublicStackResponse['latest']> = {},
): GetPublicStackResponse => ({
  stackId: '00000000-0000-4000-8000-0000000000e0',
  owner: 'alice',
  slug: 'frontend',
  displayName: 'frontend',
  description: 'Frontend Stack',
  updatedAt: '2026-09-19T00:00:00.000Z',
  latest: {
    version: {
      versionId: '00000000-0000-4000-8000-000000000001',
      versionNumber: 1,
      versionHash: bundle.stack.versionHash,
      digest: bundle.digest,
      createdAt: '2026-09-19T00:00:00.000Z',
    },
    bundle,
    ...overrides,
  },
});

describe('resolvePublicStackSource', () => {
  it('resolves and verifies a well-formed public Stack', async () => {
    const source = await resolvePublicStackSource({
      client: { getPublicStack: async () => response() },
      ref: '@alice/frontend',
    });
    expect(source.owner).toBe('alice');
    // Verified against the bundle's own stored hash, not recomputed over the LOCAL
    // round-tripped requirement shape: a snapshot-restored requirement's local shape carries
    // an inert placeholder `snapshotId` (see `publicBundleToImportedVersion`), which
    // necessarily differs from the public contentHash-only shape the hash was computed over.
    expect(source.version.versionHash).toBe(bundle.stack.versionHash);
    const restoration = source.restorations.get('req_design01');
    // Snapshot-first publication: `buildPublicStackBundle` always emits a snapshot
    // restoration now, even for this Git-backed source.
    expect(restoration?.strategy).toBe('snapshot');
    expect(
      restoration?.strategy === 'snapshot'
        ? restoration.contentHash
        : undefined,
    ).toBe(contentHash);
  });

  it('rejects a tampered digest', async () => {
    await expect(
      resolvePublicStackSource({
        client: {
          getPublicStack: async () =>
            response({
              bundle: { ...bundle, digest: `sha256:${'f'.repeat(64)}` },
            }),
        },
        ref: '@alice/frontend',
      }),
    ).rejects.toBeInstanceOf(CloudBundleInvalidError);
  });

  it('reports a missing public Stack', async () => {
    await expect(
      resolvePublicStackSource({
        client: { getPublicStack: async () => null },
        ref: '@alice/frontend',
      }),
    ).rejects.toBeInstanceOf(PublicStackNotFoundError);
  });
});

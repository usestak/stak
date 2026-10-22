import { describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  type RemoteMemoryBackend,
} from '../remote/backend.js';
import { standardCloudBackup, protectedCloudBackup } from '../remote/modes.js';
import { generateMmk } from '../remote/mmk.js';
import { writeSyntheticStore } from '../remote/store.fixtures.js';
import { emptyRegistry, type LocalRegistry } from '../project/registry.js';
import { mintProjectId } from '../project/project-id.js';
import { writeCanonicalMain } from './store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalMainManifest } from './domain.js';
import { fetchRemoteCanonical } from './fetch-remote-canonical.js';

// Follows the exact InMemoryRemoteMemoryStore/backend construction pattern used in
// packages/memory/src/remote/modes.test.ts.
const backendFor = (
  userId: string,
): { store: InMemoryRemoteMemoryStore; backend: RemoteMemoryBackend } => {
  const store = new InMemoryRemoteMemoryStore();
  return { store, backend: inMemoryRemoteMemoryBackend(store, userId) };
};

describe('fetchRemoteCanonical', () => {
  it('returns null when there is no Cloud generation yet', async () => {
    const { backend } = backendFor('user-a');
    const result = await fetchRemoteCanonical({
      backend,
      localRegistry: emptyRegistry(),
    });
    expect(result).toBeNull();
  });

  it('reads the canonical manifest directly from a v2 generation', async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    const projectId = mintProjectId();
    const canonicalMain: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId,
          documents: [
            {
              path: 'notes/f0.md',
              state: 'present',
              contentHash: source.hashes[0]!,
              importedFrom: 'claude',
              importedAt: '2026-09-25T12:00:00.000Z',
            },
          ],
        },
      ],
    };
    await writeCanonicalMain(source.stackHome, canonicalMain);

    const { backend } = backendFor('user-a');
    const backup = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });

    const result = await fetchRemoteCanonical({
      backend,
      localRegistry: emptyRegistry(),
    });
    expect(result).not.toBeNull();
    expect(result?.generation).toBe(backup.generation);
    expect(result?.main).toEqual(canonicalMain);
  });

  it('falls back to convertV1Bundle for a v1 generation, using the provided localRegistry', async () => {
    // No canonical/main.json written — bundleFromStore produces a v1 bundle.
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 2 });
    const projectId = mintProjectId();
    const localRegistry: LocalRegistry = {
      ...emptyRegistry(),
      projects: [
        {
          projectId,
          claims: [{ type: 'git', canonical: 'github.com/example/proj0' }],
          lifecycle: 'active',
        },
      ],
    };

    const { backend } = backendFor('user-a');
    const backup = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });

    const result = await fetchRemoteCanonical({ backend, localRegistry });
    expect(result).not.toBeNull();
    expect(result?.generation).toBe(backup.generation);
    expect(result?.main.projects).toHaveLength(1);
    expect(result?.main.projects[0]?.projectId).toBe(projectId);
    expect(result?.main.projects[0]?.documents).toEqual([
      {
        path: 'notes/f0.md',
        state: 'present',
        contentHash: source.hashes[0],
        importedFrom: 'claude',
        importedAt: '2026-09-25T12:00:00.000Z',
      },
      {
        path: 'notes/f1.md',
        state: 'present',
        contentHash: source.hashes[1],
        importedFrom: 'claude',
        importedAt: '2026-09-25T12:00:00.000Z',
      },
    ]);
  });

  it('decrypts a Protected v1 generation with the MMK before converting', async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    const projectId = mintProjectId();
    const localRegistry: LocalRegistry = {
      ...emptyRegistry(),
      projects: [
        {
          projectId,
          claims: [{ type: 'git', canonical: 'github.com/example/proj0' }],
          lifecycle: 'active',
        },
      ],
    };
    const mmk = generateMmk();
    const { backend } = backendFor('user-a');
    await protectedCloudBackup({ stackHome: source.stackHome, backend, mmk });

    const result = await fetchRemoteCanonical({ backend, mmk, localRegistry });
    expect(result?.main.projects[0]?.projectId).toBe(projectId);
    expect(result?.main.projects[0]?.documents).toEqual([
      {
        path: 'notes/f0.md',
        state: 'present',
        contentHash: source.hashes[0],
        importedFrom: 'claude',
        importedAt: '2026-09-25T12:00:00.000Z',
      },
    ]);
  });

  it('fails closed for Protected recovery without an MMK', async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    const { backend } = backendFor('user-a');
    await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk: generateMmk(),
    });

    await expect(
      fetchRemoteCanonical({ backend, localRegistry: emptyRegistry() }),
    ).rejects.toMatchObject({ code: 'mmk-required' });
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '../domain.js';
import {
  hashBytes,
  memoryStorePaths,
  writeMemoryManifest,
  writeMemoryObject,
} from '../store.js';
import { toPortableSnapshot } from '../project/registry.js';
import {
  readPortableSnapshot,
  writePortableSnapshot,
} from '../project/registry-store.js';
import {
  bundleFromStore,
  parseBundle,
  restoreBundleToStore,
} from './bundle-codec.js';

const roots: string[] = [];
const tempHome = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-bndl-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const seedStore = async (): Promise<string> => {
  const home = await tempHome();
  const body = Buffer.from('# atlas\nmemory\n', 'utf8');
  const contentHash = hashBytes(body);
  await writeMemoryObject({ stackHome: home, contentHash, bytes: body });
  const item: ManifestItem = {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: 'claude/auto-memory/github.com/acme/atlas/a.md',
    project: {
      kind: 'git',
      canonical: 'github.com/acme/atlas',
      host: 'github.com',
      owner: 'acme',
      repo: 'atlas',
    },
    contentHash,
    restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
    capturedAt: '2026-09-27T00:00:00.000Z',
    sensitivity: 'private',
  };
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items: [item],
  };
  await writeMemoryManifest({ stackHome: home, manifest });
  return home;
};

describe('bundle project-registry compatibility', () => {
  it('an OLD bundle with no project registry still decodes and restores', async () => {
    const source = await seedStore(); // no snapshot written
    const { bundle, bytes } = await bundleFromStore(source);
    expect(bundle.registryB64).toBeUndefined();

    const dest = await tempHome();
    const restored = await restoreBundleToStore({ bytes, stackHome: dest });
    expect(restored.objects).toBe(1);
    // No snapshot appears in the destination store.
    expect(await readPortableSnapshot(dest)).toBeNull();
  });

  it('a NEW bundle with a project registry round-trips byte-exactly', async () => {
    const source = await seedStore();
    await writePortableSnapshot(
      source,
      toPortableSnapshot({
        schemaVersion: 1,
        projects: [
          {
            projectId: 'prj_zzzzzzzzzzzzzzzzzzzzzzzzzz',
            claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
          },
        ],
        bindings: [],
      }),
    );
    const { bundle, bytes } = await bundleFromStore(source);
    expect(bundle.registryB64).toBeDefined();
    expect(bundle.registrySha256).toMatch(/^sha256:[a-f0-9]{64}$/);

    const dest = await tempHome();
    await restoreBundleToStore({ bytes, stackHome: dest });
    const sourceSnap = await readFile(
      memoryStorePaths(source).projectRegistrySnapshot,
    );
    const destSnap = await readFile(
      memoryStorePaths(dest).projectRegistrySnapshot,
    );
    expect(destSnap.equals(sourceSnap)).toBe(true);
    expect((await readPortableSnapshot(dest))?.projects[0]?.projectId).toBe(
      'prj_zzzzzzzzzzzzzzzzzzzzzzzzzz',
    );
  });

  it('rejects a bundle whose registry bytes were tampered', async () => {
    const source = await seedStore();
    await writePortableSnapshot(source, {
      snapshotVersion: 1,
      projects: [],
    });
    const { bundle } = await bundleFromStore(source);
    const tampered = parseBundle(
      Buffer.from(
        JSON.stringify({
          ...bundle,
          registryB64: Buffer.from(
            '{"snapshotVersion":1,"projects":[]} ',
          ).toString('base64'),
        }),
        'utf8',
      ),
    );
    const dest = await tempHome();
    await expect(
      restoreBundleToStore({
        bytes: Buffer.from(JSON.stringify(tampered), 'utf8'),
        stackHome: dest,
      }),
    ).rejects.toThrow();
  });
});

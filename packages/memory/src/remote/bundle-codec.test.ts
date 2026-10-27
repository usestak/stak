import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeMemoryManifest } from '../store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION } from '../canonical/domain.js';
import { readCanonicalMain, writeCanonicalMain } from '../canonical/store.js';
import {
  BUNDLE_FORMAT_V2,
  bundleFromStore,
  restoreBundleToStore,
} from './bundle-codec.js';

const roots: string[] = [];
const temp = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-bndl-v2-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe('v2 canonical bundling', () => {
  it('emits a v2 bundle with the canonical manifest when one exists', async () => {
    const stackHome = await temp();
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [],
      },
    });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [] },
      ],
    });
    const { bundle } = await bundleFromStore(stackHome);
    expect(bundle.bundleFormat).toBe(BUNDLE_FORMAT_V2);
    expect(bundle.canonicalB64).toBeDefined();
  });

  it('round-trips the canonical manifest through restoreBundleToStore', async () => {
    const source = await temp();
    await writeMemoryManifest({
      stackHome: source,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [],
      },
    });
    const canonical = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [] },
      ],
    };
    await writeCanonicalMain(source, canonical);
    const { bytes } = await bundleFromStore(source);

    const target = await temp();
    await restoreBundleToStore({ bytes, stackHome: target });
    expect(await readCanonicalMain(target)).toEqual(canonical);
  });

  it('still emits v1 when no canonical manifest exists on disk (back-compat)', async () => {
    const stackHome = await temp();
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [],
      },
    });
    const { bundle } = await bundleFromStore(stackHome);
    expect(bundle.bundleFormat).toBe('stack-mem-bundle-v1');
    expect(bundle.canonicalB64).toBeUndefined();
  });
});

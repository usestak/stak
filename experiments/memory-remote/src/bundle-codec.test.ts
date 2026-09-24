import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { memoryStorePaths, readMemoryObject } from '@stack/memory';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BundleError,
  bundleFromStore,
  parseBundle,
  restoreBundleToStore,
} from './bundle-codec.js';
import { writeSyntheticStore } from './fixtures.js';

const roots: string[] = [];
const emptyStackHome = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-spike-dst-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('MemoryBackupCodec', () => {
  it('reconstructs the Phase 14A store byte-for-byte on a fresh machine', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);

    const { bytes } = await bundleFromStore(source.stackHome);
    const destination = await emptyStackHome();
    const result = await restoreBundleToStore({
      bytes,
      stackHome: destination,
    });

    expect(result.objects).toBe(source.hashes.length);

    // Manifest file is byte-identical.
    const original = await readFile(
      memoryStorePaths(source.stackHome).currentManifest,
    );
    const recovered = await readFile(
      memoryStorePaths(destination).currentManifest,
    );
    expect(recovered.equals(original)).toBe(true);

    // Every object is byte-identical (verified by content hash on read).
    for (const contentHash of source.hashes) {
      const a = await readMemoryObject({
        stackHome: source.stackHome,
        contentHash,
      });
      const b = await readMemoryObject({ stackHome: destination, contentHash });
      expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    }
  });

  it('is deterministic: same store bundles to identical bytes', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const first = await bundleFromStore(source.stackHome);
    const second = await bundleFromStore(source.stackHome);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it('rejects a store with no backup', async () => {
    const empty = await emptyStackHome();
    await expect(bundleFromStore(empty)).rejects.toBeInstanceOf(BundleError);
  });

  it('rejects a bundle whose object bytes were tampered', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { bundle } = await bundleFromStore(source.stackHome);
    const firstObject = bundle.objects[0];
    expect(firstObject).toBeDefined();
    if (!firstObject) return;
    const tampered = {
      ...bundle,
      objects: [
        {
          contentHash: firstObject.contentHash,
          bytesB64: Buffer.from('tampered').toString('base64'),
        },
      ],
    };
    const bytes = Buffer.from(JSON.stringify(tampered), 'utf8');
    // Re-parse succeeds (schema-valid) but restore detects the hash mismatch.
    expect(() => parseBundle(bytes)).not.toThrow();
    const destination = await emptyStackHome();
    await expect(
      restoreBundleToStore({ bytes, stackHome: destination }),
    ).rejects.toMatchObject({ code: 'object-hash-mismatch' });
  });
});

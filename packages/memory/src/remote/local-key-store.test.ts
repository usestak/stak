import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { memoryStorePaths } from '../store.js';
import { generateMmk } from './mmk.js';
import {
  LocalKeyStoreError,
  fileLocalMemoryKeyStore,
} from './local-key-store.js';

const roots: string[] = [];
const home = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-14b-keys-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const envelopePath = (stackHome: string) =>
  path.join(memoryStorePaths(stackHome).root, 'keys', 'device-mmk.json');

describe('LocalMemoryKeyStore', () => {
  it('saves and loads the MMK across store instances (device enrollment)', async () => {
    const stackHome = await home();
    const mmk = generateMmk();
    await fileLocalMemoryKeyStore(stackHome).saveMmk(mmk);
    const loaded = await fileLocalMemoryKeyStore(stackHome).loadMmk();
    expect(loaded?.equals(mmk)).toBe(true);
    expect(await fileLocalMemoryKeyStore(stackHome).hasKey()).toBe(true);
  });

  it('returns null when the device is not enrolled', async () => {
    const stackHome = await home();
    expect(await fileLocalMemoryKeyStore(stackHome).loadMmk()).toBeNull();
    expect(await fileLocalMemoryKeyStore(stackHome).hasKey()).toBe(false);
  });

  it('never writes the raw MMK in plaintext on disk', async () => {
    const stackHome = await home();
    const mmk = generateMmk();
    await fileLocalMemoryKeyStore(stackHome).saveMmk(mmk);
    const onDisk = await readFile(envelopePath(stackHome));
    // The raw MMK bytes (and their base64) must not appear in the envelope file.
    expect(onDisk.includes(mmk)).toBe(false);
    expect(onDisk.toString('utf8')).not.toContain(mmk.toString('base64'));
  });

  it('fails closed on a corrupt envelope (does not silently return a wrong key)', async () => {
    const stackHome = await home();
    await fileLocalMemoryKeyStore(stackHome).saveMmk(generateMmk());
    const file = envelopePath(stackHome);
    const parsed = JSON.parse((await readFile(file)).toString('utf8')) as {
      ciphertextB64: string;
    };
    parsed.ciphertextB64 = Buffer.from('tampered').toString('base64');
    await writeFile(file, JSON.stringify(parsed), { mode: 0o600 });
    await expect(
      fileLocalMemoryKeyStore(stackHome).loadMmk(),
    ).rejects.toBeInstanceOf(LocalKeyStoreError);
  });

  it('clear() removes device key state', async () => {
    const stackHome = await home();
    const store = fileLocalMemoryKeyStore(stackHome);
    await store.saveMmk(generateMmk());
    await store.clear();
    expect(await store.hasKey()).toBe(false);
    expect(await store.loadMmk()).toBeNull();
  });
});

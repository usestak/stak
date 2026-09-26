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

// Unit tests inject no-op platform hooks so they never spawn OS tools (icacls);
// the real Windows ACL behavior is verified manually (see the deployment/production
// docs) and its fail-closed logic is exercised via injected hooks below.
const secure = {
  harden: () => Promise.resolve(true),
  verify: () => Promise.resolve(true),
};
const mkStore = (h: string) => fileLocalMemoryKeyStore(h, secure);

describe('LocalMemoryKeyStore', () => {
  it('saves and loads the MMK across store instances (device enrollment)', async () => {
    const stackHome = await home();
    const mmk = generateMmk();
    await mkStore(stackHome).saveMmk(mmk);
    const loaded = await mkStore(stackHome).loadMmk();
    expect(loaded?.equals(mmk)).toBe(true);
    expect(await mkStore(stackHome).hasKey()).toBe(true);
  });

  it('returns null when the device is not enrolled', async () => {
    const stackHome = await home();
    expect(await mkStore(stackHome).loadMmk()).toBeNull();
    expect(await mkStore(stackHome).hasKey()).toBe(false);
  });

  it('never writes the raw MMK in plaintext on disk', async () => {
    const stackHome = await home();
    const mmk = generateMmk();
    await mkStore(stackHome).saveMmk(mmk);
    const onDisk = await readFile(envelopePath(stackHome));
    // The raw MMK bytes (and their base64) must not appear in the envelope file.
    expect(onDisk.includes(mmk)).toBe(false);
    expect(onDisk.toString('utf8')).not.toContain(mmk.toString('base64'));
  });

  it('fails closed on a corrupt envelope (does not silently return a wrong key)', async () => {
    const stackHome = await home();
    await mkStore(stackHome).saveMmk(generateMmk());
    const file = envelopePath(stackHome);
    const parsed = JSON.parse((await readFile(file)).toString('utf8')) as {
      ciphertextB64: string;
    };
    parsed.ciphertextB64 = Buffer.from('tampered').toString('base64');
    await writeFile(file, JSON.stringify(parsed), { mode: 0o600 });
    await expect(mkStore(stackHome).loadMmk()).rejects.toBeInstanceOf(
      LocalKeyStoreError,
    );
  });

  it('clear() removes device key state', async () => {
    const stackHome = await home();
    const store = mkStore(stackHome);
    await store.saveMmk(generateMmk());
    await store.clear();
    expect(await store.hasKey()).toBe(false);
    expect(await store.loadMmk()).toBeNull();
  });

  it('fails closed when owner-only permissions cannot be verified', async () => {
    const stackHome = await home();
    const store = fileLocalMemoryKeyStore(stackHome, {
      harden: () => Promise.resolve(false),
      verify: () => Promise.resolve(false),
    });
    await expect(store.saveMmk(generateMmk())).rejects.toMatchObject({
      code: 'insecure-permissions',
    });
    // No partial/usable key state is left behind.
    const plain = mkStore(stackHome);
    expect(await plain.hasKey()).toBe(false);
    expect(await plain.loadMmk()).toBeNull();
  });

  it('round-trips when hardening and verification succeed', async () => {
    const stackHome = await home();
    const store = fileLocalMemoryKeyStore(stackHome, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
    const mmk = generateMmk();
    await store.saveMmk(mmk);
    expect((await store.loadMmk())?.equals(mmk)).toBe(true);
  });
});

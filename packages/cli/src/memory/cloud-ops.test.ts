import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  fileLocalMemoryKeyStore,
  generateRecoveryKey,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  memoryStorePaths,
  readMemoryObject,
  writeMemoryManifest,
  writeMemoryObject,
  type BackupResult,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

import {
  readMemoryCloudStatus,
  runMemoryCloudBackup,
  runMemoryCloudProtect,
  runMemoryCloudRecover,
} from './cloud-ops.js';

const USER = 'user-ops';
const secureKeys = (dir: string) =>
  fileLocalMemoryKeyStore(dir, {
    harden: () => Promise.resolve(true),
    verify: () => Promise.resolve(true),
  });
const roots: string[] = [];
const temp = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const writeStore = async (): Promise<{
  stackHome: string;
  hashes: string[];
}> => {
  const stackHome = await temp('stack-ops-src-');
  const items: ManifestItem[] = [];
  const hashes: string[] = [];
  for (let f = 0; f < 3; f += 1) {
    const body = Buffer.from(`# file ${f}\ncontent ${f}\n`, 'utf8');
    const contentHash = hashBytes(body);
    await writeMemoryObject({ stackHome, contentHash, bytes: body });
    hashes.push(contentHash);
    items.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/github.com/example/atlas/f${f}.md`,
      project: {
        kind: 'git',
        canonical: 'github.com/example/atlas',
        host: 'github.com',
        owner: 'example',
        repo: 'atlas',
      },
      contentHash,
      restoreTarget: {
        base: 'claude-project-memory',
        relativePath: `f${f}.md`,
      },
      capturedAt: '2026-09-25T12:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-25T12:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return { stackHome, hashes };
};

const fakeBackup = (): Promise<BackupResult> =>
  Promise.resolve({
    provider: 'claude',
    files: 3,
    projects: 1,
    createdAt: '2026-09-25T12:00:00.000Z',
  });

const assertByteExact = async (a: string, b: string, hashes: string[]) => {
  expect(
    (await readFile(memoryStorePaths(b).currentManifest)).equals(
      await readFile(memoryStorePaths(a).currentManifest),
    ),
  ).toBe(true);
  for (const h of hashes) {
    const oa = await readMemoryObject({ stackHome: a, contentHash: h });
    const ob = await readMemoryObject({ stackHome: b, contentHash: h });
    expect(Buffer.from(ob).equals(Buffer.from(oa))).toBe(true);
  }
};

describe('memory cloud operations', () => {
  it('backup succeeds locally and skips Cloud when not authenticated', async () => {
    const source = await writeStore();
    const keys = secureKeys(await temp('stack-ops-keys-'));
    const outcome = await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend: null,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(outcome.local.files).toBe(3);
    expect(outcome.cloud.status).toBe('skipped');
  });

  it('Standard backup then recover byte-exactly', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-keys-'));
    const out = await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(out.cloud.status).toBe('standard');

    const dest = await temp('stack-ops-dst-');
    const rec = await runMemoryCloudRecover({
      stackHome: dest,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(rec.status).toBe('recovered');
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('protect enables Protected, enrolls the device, and backs up Protected', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-keys-'));
    // Seed a Standard backup so migration has something to convert.
    await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    const recoveryKey = generateRecoveryKey();
    const protectResult = await runMemoryCloudProtect(
      {
        stackHome: source.stackHome,
        backend,
        localKeyStore: keys,
        runLocalBackup: fakeBackup,
      },
      { recoveryKey },
    );
    expect(protectResult.status).toBe('protected');
    if (protectResult.status === 'protected')
      expect(protectResult.migrated).toBe(1);
    expect(await keys.hasKey()).toBe(true);
    expect((await backend.getProfile())?.privacyMode).toBe('protected');

    // A subsequent everyday backup is Protected without any prompt.
    const out = await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(out.cloud.status).toBe('protected');
  });

  it('fails closed: Protected account on a device without the MMK never uploads Standard', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const deviceA = secureKeys(await temp('stack-ops-a-'));
    await runMemoryCloudProtect(
      {
        stackHome: source.stackHome,
        backend,
        localKeyStore: deviceA,
        runLocalBackup: fakeBackup,
      },
      { recoveryKey: generateRecoveryKey() },
    );
    // Device B: authenticated, account is Protected, but holds no MMK.
    const deviceB = secureKeys(await temp('stack-ops-b-'));
    const out = await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: deviceB,
      runLocalBackup: fakeBackup,
    });
    expect(out.local.files).toBe(3); // local still safe
    expect(out.cloud.status).toBe('protected-locked'); // never a Standard fallback
  });

  it('recovers Protected on a fresh device using a recovery key, enrolling it', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const deviceA = secureKeys(await temp('stack-ops-a-'));
    await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: deviceA,
      runLocalBackup: fakeBackup,
    });
    const recoveryKey = generateRecoveryKey();
    await runMemoryCloudProtect(
      {
        stackHome: source.stackHome,
        backend,
        localKeyStore: deviceA,
        runLocalBackup: fakeBackup,
      },
      { recoveryKey },
    );

    // Fresh device: no local MMK. Recovery key unlocks and enrolls it.
    const deviceB = secureKeys(await temp('stack-ops-b-'));
    const dest = await temp('stack-ops-dst-');
    const locked = await runMemoryCloudRecover({
      stackHome: dest,
      backend,
      localKeyStore: deviceB,
      runLocalBackup: fakeBackup,
    });
    expect(locked.status).toBe('needs-recovery-method');

    const rec = await runMemoryCloudRecover(
      {
        stackHome: dest,
        backend,
        localKeyStore: deviceB,
        runLocalBackup: fakeBackup,
      },
      { recoveryKey: recoveryKey.keyBytes },
    );
    expect(rec.status).toBe('recovered');
    if (rec.status === 'recovered') expect(rec.privacyMode).toBe('protected');
    expect(await deviceB.hasKey()).toBe(true); // device now enrolled
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('status reports authentication, privacy mode, and enrollment', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-keys-'));
    await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    const status = await readMemoryCloudStatus({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(status.authenticated).toBe(true);
    expect(status.privacyMode).toBe('standard');
    expect(status.latestGeneration).toBe(0);
  });

  it('protect fails closed and does not finalize Protected when the local key cannot be secured', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = fileLocalMemoryKeyStore(await temp('stack-ops-insecure-'), {
      harden: () => Promise.resolve(false),
      verify: () => Promise.resolve(false),
    });
    // Seed a Standard backup so a false "Protected" would be observable.
    await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });

    const result = await runMemoryCloudProtect(
      {
        stackHome: source.stackHome,
        backend,
        localKeyStore: keys,
        runLocalBackup: fakeBackup,
      },
      { recoveryKey: generateRecoveryKey() },
    );

    expect(result.status).toBe('insecure-local-key');
    // Cloud is NOT finalized Protected, no recovery method is stored, device not enrolled.
    expect((await backend.getProfile())?.privacyMode ?? 'standard').toBe(
      'standard',
    );
    expect(await backend.listRecoveryMethods()).toHaveLength(0);
    expect(await keys.hasKey()).toBe(false);
    // The Standard backup remains usable.
    expect((await backend.getLatest())?.privacyMode).toBe('standard');
  });
});

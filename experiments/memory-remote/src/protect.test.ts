import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { memoryStorePaths, readMemoryObject } from '@stack/memory';
import { afterEach, describe, expect, it } from 'vitest';

import { BackendError, InMemoryRemoteBackend } from './backend.js';
import { CipherError } from './cipher.js';
import { writeSyntheticStore } from './fixtures.js';
import { generateRecoveryKey } from './recovery-key.js';
import { protect, recover } from './protect.js';

const roots: string[] = [];
const newMachine = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-spike-new-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const USER = 'user-123';

describe('Option A protect → recover (offline end-to-end)', () => {
  it('recovers byte-exactly on a new machine: original hash == recovered hash', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();

    await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });

    // Brand-new machine: empty store, no local key state — only the recovery key.
    const destination = await newMachine();
    const result = await recover({
      stackHome: destination,
      backend,
      userId: USER,
      recoveryKey,
    });

    expect(result.objects).toBe(source.hashes.length);
    const original = await readFile(
      memoryStorePaths(source.stackHome).currentManifest,
    );
    const recovered = await readFile(
      memoryStorePaths(destination).currentManifest,
    );
    expect(recovered.equals(original)).toBe(true);
    for (const contentHash of source.hashes) {
      const a = await readMemoryObject({
        stackHome: source.stackHome,
        contentHash,
      });
      const b = await readMemoryObject({ stackHome: destination, contentHash });
      expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    }
  });

  it('lost device + valid recovery key = full recovery from nothing local', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });

    const destination = await newMachine();
    await expect(
      recover({ stackHome: destination, backend, userId: USER, recoveryKey }),
    ).resolves.toMatchObject({ objects: 2 });
  });

  it('wrong recovery key cannot decrypt', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey: generateRecoveryKey(),
      generation: 0,
    });
    const destination = await newMachine();
    await expect(
      recover({
        stackHome: destination,
        backend,
        userId: USER,
        recoveryKey: generateRecoveryKey(),
      }),
    ).rejects.toMatchObject({ code: 'unwrap-failed' });
  });

  it('Stack account access alone (ciphertext + wrapped key, no recovery key) cannot decrypt', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey: generateRecoveryKey(),
      generation: 0,
    });
    // Everything the provider holds is visible here — yet none of it yields a DEK.
    const held = backend.inspect();
    expect(held.records).toHaveLength(1);
    expect(held.objects).toHaveLength(1);
    // Attempting recovery without the recovery key (attacker guesses one) fails:
    // the wrapped DEK never unwraps, so the ciphertext stays opaque.
    const destination = await newMachine();
    await expect(
      recover({
        stackHome: destination,
        backend,
        userId: USER,
        recoveryKey: generateRecoveryKey(),
      }),
    ).rejects.toMatchObject({ code: 'unwrap-failed' });
  });

  it('detects a corrupted remote object before decrypting', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    const done = await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });
    backend.corruptObject(`mem/${USER}/${done.backupId}`);
    const destination = await newMachine();
    await expect(
      recover({ stackHome: destination, backend, userId: USER, recoveryKey }),
    ).rejects.toMatchObject({ code: 'ciphertext-corrupt' });
  });

  it('detects a truncated remote object', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    const done = await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });
    backend.truncateObject(`mem/${USER}/${done.backupId}`, 8);
    const destination = await newMachine();
    await expect(
      recover({ stackHome: destination, backend, userId: USER, recoveryKey }),
    ).rejects.toMatchObject({ code: 'ciphertext-corrupt' });
  });

  it('fails closed when authenticated metadata is tampered', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    const done = await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });
    // createdAt is bound into the AEAD AAD; changing it must break decryption.
    backend.tamperRecord(USER, done.backupId, {
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const destination = await newMachine();
    await expect(
      recover({ stackHome: destination, backend, userId: USER, recoveryKey }),
    ).rejects.toBeInstanceOf(CipherError);
  });

  it('rejects a rollback to an older generation (replay of a stale backup)', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    const gen0 = await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 0,
    });
    const gen1 = await protect({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      recoveryKey,
      generation: 1,
      parentBackupId: gen0.backupId,
    });
    // The device knows it is at generation 1.
    const destination = await newMachine();
    await expect(
      recover({
        stackHome: destination,
        backend,
        userId: USER,
        recoveryKey,
        minGeneration: 1,
      }),
    ).resolves.toMatchObject({ generation: 1 });

    // Attacker deletes the newest backup, leaving only the stale generation 0.
    backend.deleteBackup(USER, gen1.backupId);
    const destination2 = await newMachine();
    await expect(
      recover({
        stackHome: destination2,
        backend,
        userId: USER,
        recoveryKey,
        minGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'rollback-detected' });
  });

  it('rejects a duplicate backup id (idempotency guard)', async () => {
    const backend = new InMemoryRemoteBackend();
    const record = {
      userId: USER,
      backupId: 'fixed-id',
      createdAt: '2026-09-24T12:00:00.000Z',
      ciphertextLocator: 'mem/user/fixed-id',
      ciphertextSha256: `sha256:${'a'.repeat(64)}`,
      cryptoVersion: 'stack-mem-cipher-v1',
      wrappedKeyRecord: {
        scheme: 'recovery-key-scrypt-aesgcm-v1' as const,
        kdf: { name: 'scrypt' as const, N: 32768, r: 8, p: 1, keyLen: 32 },
        saltB64: 'AA==',
        nonceB64: 'AA==',
        ciphertextB64: 'AA==',
        tagB64: 'AA==',
      },
      backupGeneration: 0,
      parentBackupId: null,
    };
    await backend.putRecord(record);
    await expect(
      (async () => {
        await backend.putRecord(record);
      })(),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it('reports no backups for an unknown user', async () => {
    const backend = new InMemoryRemoteBackend();
    const destination = await newMachine();
    await expect(
      recover({
        stackHome: destination,
        backend,
        userId: 'nobody',
        recoveryKey: generateRecoveryKey(),
      }),
    ).rejects.toMatchObject({ code: 'no-backups' });
  });
});

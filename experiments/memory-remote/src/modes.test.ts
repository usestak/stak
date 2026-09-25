import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { memoryStorePaths, readMemoryObject } from '@stack/memory';
import { afterEach, describe, expect, it } from 'vitest';

import { SECRET_MARKER, writeSyntheticStore } from './fixtures.js';
import { generateMmk, newKeyring } from './mmk.js';
import {
  InMemoryModeBackend,
  ModeError,
  migrateStandardToProtected,
  protectedBackup,
  protectedRecover,
  standardBackup,
  standardRecover,
} from './modes.js';

const roots: string[] = [];
const newMachine = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-14b1-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const USER = 'user-abc';
const OTHER = 'user-xyz';

const assertByteExact = async (
  sourceHome: string,
  destHome: string,
  hashes: string[],
) => {
  const a = await readFile(memoryStorePaths(sourceHome).currentManifest);
  const b = await readFile(memoryStorePaths(destHome).currentManifest);
  expect(b.equals(a)).toBe(true);
  for (const contentHash of hashes) {
    const oa = await readMemoryObject({ stackHome: sourceHome, contentHash });
    const ob = await readMemoryObject({ stackHome: destHome, contentHash });
    expect(Buffer.from(ob).equals(Buffer.from(oa))).toBe(true);
  }
};

describe('Standard mode', () => {
  it('backs up and recovers byte-exactly on a fresh client', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    await standardBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
    });

    const dest = await newMachine();
    const result = await standardRecover({
      stackHome: dest,
      backend,
      userId: USER,
    });
    expect(result.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('does not let another user retrieve the payload', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const record = await standardBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
    });
    await expect(
      (async () => backend.getPayload(OTHER, record.payloadLocator))(),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a corrupted payload', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const record = await standardBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
    });
    backend.corruptPayload(record.payloadLocator);
    const dest = await newMachine();
    await expect(
      standardRecover({ stackHome: dest, backend, userId: USER }),
    ).rejects.toMatchObject({
      code: 'integrity',
    });
  });
});

describe('Protected mode', () => {
  it('backs up and recovers byte-exactly; original hash == recovered hash', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const mmk = generateMmk();
    const keyring = newKeyring();
    await protectedBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      mmk,
      keyring,
    });

    const dest = await newMachine();
    const result = await protectedRecover({
      stackHome: dest,
      backend,
      userId: USER,
      mmk,
    });
    expect(result.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('stores ciphertext only — no plaintext or project identity on the server', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const keyring = newKeyring();
    const record = await protectedBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      mmk: generateMmk(),
      keyring,
    });
    const payload = await backend.getPayload(USER, record.payloadLocator);
    const haystack = `${Buffer.from(payload).toString('utf8')}\n${JSON.stringify(record)}`;
    expect(haystack).not.toContain(SECRET_MARKER);
    expect(haystack).not.toContain('github.com/example');
    expect(haystack).not.toContain('proj0');
  });

  it('a wrong MMK (Stack account access alone) cannot decrypt', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    await protectedBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      mmk: generateMmk(),
      keyring: newKeyring(),
    });
    const dest = await newMachine();
    await expect(
      protectedRecover({
        stackHome: dest,
        backend,
        userId: USER,
        mmk: generateMmk(),
      }),
    ).rejects.toThrow();
  });

  it('rejects a modified ciphertext payload', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const mmk = generateMmk();
    const record = await protectedBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
      mmk,
      keyring: newKeyring(),
    });
    backend.corruptPayload(record.payloadLocator);
    const dest = await newMachine();
    await expect(
      protectedRecover({ stackHome: dest, backend, userId: USER, mmk }),
    ).rejects.toMatchObject({ code: 'integrity' });
  });
});

describe('Mode migration: Standard → Protected', () => {
  it('replaces Standard payloads, leaves no active Standard plaintext, and finalizes', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const std = await standardBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
    });

    const mmk = generateMmk();
    const keyring = newKeyring();
    const result = await migrateStandardToProtected({
      backend,
      userId: USER,
      mmk,
      keyring,
    });

    expect(result.finalized).toBe(true);
    expect(result.migrated).toBe(1);
    // The Standard plaintext payload is gone.
    expect(backend.hasPayload(std.payloadLocator)).toBe(false);
    // Account is Protected and a Protected recover reproduces the bytes.
    expect(await backend.getAccountMode(USER)).toBe('protected');
    const dest = await newMachine();
    const recovered = await protectedRecover({
      stackHome: dest,
      backend,
      userId: USER,
      mmk,
    });
    expect(recovered.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('a failed migration does not mark the account Protected or delete Standard payloads', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const backend = new InMemoryModeBackend();
    const std = await standardBackup({
      stackHome: source.stackHome,
      backend,
      userId: USER,
    });

    // Corrupt the Standard payload so migration's pre-verify fails.
    backend.corruptPayload(std.payloadLocator);
    await expect(
      migrateStandardToProtected({
        backend,
        userId: USER,
        mmk: generateMmk(),
        keyring: newKeyring(),
      }),
    ).rejects.toBeInstanceOf(ModeError);

    // Account stays Standard; the (corrupted) Standard payload was not deleted.
    expect(await backend.getAccountMode(USER)).toBe('standard');
    expect(backend.hasPayload(std.payloadLocator)).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { memoryStorePaths } from '../store.js';
import { readMemoryObject } from '../store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION } from '../canonical/domain.js';
import { writeCanonicalMain } from '../canonical/store.js';
import {
  InMemoryRemoteMemoryStore,
  RemoteMemoryError,
  inMemoryRemoteMemoryBackend,
  type RemoteMemoryBackend,
} from './backend.js';
import { generateMmk } from './mmk.js';
import {
  cloudRecover,
  isProtectInProgress,
  migrateStandardToProtected,
  protectedCloudBackup,
  standardCloudBackup,
} from './modes.js';
import { SECRET_MARKER, writeSyntheticStore } from './store.fixtures.js';

const roots: string[] = [];
const freshStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-14b-dst-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const backendFor = (
  userId: string,
): { store: InMemoryRemoteMemoryStore; backend: RemoteMemoryBackend } => {
  const store = new InMemoryRemoteMemoryStore();
  return { store, backend: inMemoryRemoteMemoryBackend(store, userId) };
};

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

describe('Standard cloud backup/recover', () => {
  it('backs up and recovers byte-exactly on a fresh client', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const result = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    expect(result.privacyMode).toBe('standard');
    expect(result.generation).toBe(0);

    const dest = await freshStore();
    const recovered = await cloudRecover({ stackHome: dest, backend });
    expect(recovered.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('increments generations and tracks parent', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const g0 = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    const g1 = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    expect(g0.generation).toBe(0);
    expect(g1.generation).toBe(1);
    const latest = await backend.getLatest();
    expect(latest?.generation).toBe(1);
    expect(latest?.parentGeneration).toBe(0);
  });

  it('rejects a stale parent (concurrent backup conflict, no last-writer-wins)', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    await standardCloudBackup({ stackHome: source.stackHome, backend }); // gen 0
    // Another device committed gen 1 meanwhile; this device still thinks parent=null.
    await standardCloudBackup({ stackHome: source.stackHome, backend }); // gen 1
    await expect(
      backend.createGeneration({
        backupId: 'x',
        expectedParent: 0, // stale (latest is now 1)
        privacyMode: 'standard',
        payload: Buffer.from('x'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not let another user retrieve the payload', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const store = new InMemoryRemoteMemoryStore();
    const alice = inMemoryRemoteMemoryBackend(store, 'alice');
    const mallory = inMemoryRemoteMemoryBackend(store, 'mallory');
    const backup = await standardCloudBackup({
      stackHome: source.stackHome,
      backend: alice,
    });
    await expect(
      (async () => mallory.getPayload(backup.backupId))(),
    ).rejects.toMatchObject({ code: 'not-found' });
    // Mallory sees none of Alice's generations.
    expect(await mallory.listGenerations()).toHaveLength(0);
  });

  it('rejects a corrupted payload on recover', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const backup = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    store.corruptPayload(`mem/user-a/${backup.backupId}`);
    const dest = await freshStore();
    await expect(
      cloudRecover({ stackHome: dest, backend }),
    ).rejects.toMatchObject({
      code: 'integrity',
    });
  });
});

describe('Protected cloud backup/recover', () => {
  it('recovers byte-exactly; original hash == recovered hash', async () => {
    const source = await writeSyntheticStore({
      projects: 3,
      filesPerProject: 3,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const mmk = generateMmk();
    const result = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk,
    });
    expect(result.privacyMode).toBe('protected');

    const dest = await freshStore();
    const recovered = await cloudRecover({ stackHome: dest, backend, mmk });
    expect(recovered.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('uses a fresh DEK per generation (ciphertext differs for identical input)', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const mmk = generateMmk();
    const a = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk,
    });
    const b = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk,
    });
    const pa = await backend.getPayload(a.backupId);
    const pb = await backend.getPayload(b.backupId);
    expect(Buffer.from(pa).equals(Buffer.from(pb))).toBe(false);
  });

  it('stores ciphertext only — no plaintext or project identity on the server', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const backup = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk: generateMmk(),
    });
    const payload = await backend.getPayload(backup.backupId);
    const meta = await backend.getGenerationById(backup.backupId);
    const haystack = `${Buffer.from(payload).toString('utf8')}\n${JSON.stringify(meta)}`;
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
    const { backend } = backendFor('user-a');
    await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk: generateMmk(),
    });
    const dest = await freshStore();
    await expect(
      cloudRecover({ stackHome: dest, backend, mmk: generateMmk() }),
    ).rejects.toThrow();
  });

  it('protected recover without an MMK fails closed', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk: generateMmk(),
    });
    const dest = await freshStore();
    await expect(
      cloudRecover({ stackHome: dest, backend }),
    ).rejects.toMatchObject({
      code: 'mmk-required',
    });
  });

  it('rejects a tampered ciphertext payload', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const mmk = generateMmk();
    const backup = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk,
    });
    store.corruptPayload(`mem/user-a/${backup.backupId}`);
    const dest = await freshStore();
    await expect(
      cloudRecover({ stackHome: dest, backend, mmk }),
    ).rejects.toMatchObject({
      code: 'integrity',
    });
  });
});

describe('Standard → Protected migration', () => {
  it('replaces payloads, verifies, retires Standard, and finalizes', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const std = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    const mmk = generateMmk();

    const result = await migrateStandardToProtected({ backend, mmk });
    expect(result.finalized).toBe(true);
    expect(result.migrated).toBe(1);
    expect(store.hasPayload(`mem/user-a/${std.backupId}`)).toBe(false); // Standard retired
    expect((await backend.getProfile())?.privacyMode).toBe('protected');

    const dest = await freshStore();
    const recovered = await cloudRecover({ stackHome: dest, backend, mmk });
    expect(recovered.privacyMode).toBe('protected');
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('a failed migration leaves the account Standard and the Standard payload usable', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const std = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    store.corruptPayload(`mem/user-a/${std.backupId}`); // pre-verify fails

    await expect(
      migrateStandardToProtected({ backend, mmk: generateMmk() }),
    ).rejects.toBeInstanceOf(RemoteMemoryError);
    expect((await backend.getProfile())?.privacyMode ?? 'standard').toBe(
      'standard',
    );
    expect(store.hasPayload(`mem/user-a/${std.backupId}`)).toBe(true);
  });

  it('copies oldest-first: a v1 Standard generation followed by a v2 one protects successfully, and latest afterwards is the v2 copy (Task 13 fix round 2, Important-3)', async () => {
    const source = await writeSyntheticStore({
      projects: 1,
      filesPerProject: 1,
    });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');

    // Generation 0: v1 (no canonical Memory yet).
    const v1 = await standardCloudBackup({ stackHome: source.stackHome, backend });
    expect(v1.generation).toBe(0);

    // Generation 1: v2 (canonical Memory now exists on disk).
    await writeCanonicalMain(source.stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [],
    });
    const v2 = await standardCloudBackup({ stackHome: source.stackHome, backend });
    expect(v2.generation).toBe(1);

    const mmk = generateMmk();
    // Pre-fix, this copied newest-first (v2 then v1) — the v1 copy that
    // followed was rejected by the server's own v1-after-v2 gate
    // (Critical-2), and the oldest original ended up as the new "latest".
    const result = await migrateStandardToProtected({ backend, mmk });
    expect(result.finalized).toBe(true);
    expect(result.migrated).toBe(2);

    const latest = await backend.getLatest();
    expect(latest?.privacyMode).toBe('protected');
    expect(latest?.bundleFormatVersion).toBe('stack-mem-bundle-v2');
    // The v2 copy must be the highest generation number — oldest-first
    // copying means it was created LAST.
    const generations = await backend.listGenerations();
    const protectedOnly = generations.filter((g) => g.privacyMode === 'protected');
    expect(protectedOnly).toHaveLength(2);
    const v2Copy = protectedOnly.find((g) => g.bundleFormatVersion === 'stack-mem-bundle-v2');
    const v1Copy = protectedOnly.find((g) => g.bundleFormatVersion === 'stack-mem-bundle-v1');
    expect(v2Copy?.generation).toBeGreaterThan(v1Copy?.generation ?? -1);
    expect(latest?.generation).toBe(v2Copy?.generation);
  });
});

describe('protect replicas and the sticky v1-after-v2 gate (Task 13 fix round 3, A)', () => {
  const V1 = 'stack-mem-bundle-v1';
  const V2 = 'stack-mem-bundle-v2';

  /** g0: v1 Standard, g1: v2 Standard (a real mixed-history account). */
  const mixedHistory = async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const v1 = await standardCloudBackup({ stackHome: source.stackHome, backend });
    await writeCanonicalMain(source.stackHome, { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] });
    const v2 = await standardCloudBackup({ stackHome: source.stackHome, backend });
    const original = (await backend.getGenerationById(v1.backupId))!;
    return { source, store, backend, v1, v2, original };
  };

  const parentOf = async (backend: RemoteMemoryBackend) => (await backend.getLatest())?.generation ?? null;

  const create = async (
    backend: RemoteMemoryBackend,
    input: { bundleFormatVersion: string; privacyMode: 'standard' | 'protected'; bytes: number; replicaOf?: string },
  ) =>
    backend.createGeneration({
      backupId: randomUUID(),
      expectedParent: await parentOf(backend),
      privacyMode: input.privacyMode,
      payload: Buffer.alloc(input.bytes, 7),
      bundleFormatVersion: input.bundleFormatVersion,
      ...(input.replicaOf !== undefined ? { replicaOf: input.replicaOf } : {}),
    });

  it('refuses an old-CLI v1 Standard push once ANY v2 was ever committed — even when latest is a v1 replica', async () => {
    const { backend, original } = await mixedHistory();
    // A legitimate v1 replica of g0 becomes latest.
    const replica = await create(backend, {
      bundleFormatVersion: V1,
      privacyMode: 'protected',
      bytes: original.payloadBytes + 28,
      replicaOf: original.backupId,
    });
    expect((await backend.getLatest())?.backupId).toBe(replica.backupId);
    expect((await backend.getLatest())?.bundleFormatVersion).toBe(V1);
    // An old CLI's v1 Standard push is still refused, with the exact message.
    await expect(create(backend, { bundleFormatVersion: V1, privacyMode: 'standard', bytes: 10 })).rejects.toMatchObject({
      code: 'incompatible-format',
      message: "This account's Memory was upgraded by a newer STAK CLI. Update with `npm i -g @memstk/cli@beta`.",
    });
    expect((await backend.getLatest())?.backupId).toBe(replica.backupId);
  });

  it('refuses forged replicas: unknown original, wrong format, wrong length, Standard replica, second replica, after finalize', async () => {
    const { backend, original, v2 } = await mixedHistory();
    const ok = { bundleFormatVersion: V1, privacyMode: 'protected' as const, bytes: original.payloadBytes + 28 };
    await expect(create(backend, { ...ok, replicaOf: randomUUID() })).rejects.toMatchObject({ code: 'invalid-replica' });
    await expect(create(backend, { ...ok, bundleFormatVersion: V2, replicaOf: original.backupId })).rejects.toMatchObject({
      code: 'invalid-replica',
    });
    await expect(create(backend, { ...ok, bytes: original.payloadBytes + 27, replicaOf: original.backupId })).rejects.toMatchObject({
      code: 'invalid-replica',
    });
    await expect(create(backend, { ...ok, privacyMode: 'standard', replicaOf: original.backupId })).rejects.toMatchObject({
      code: 'invalid-replica',
    });
    // A replica can't name another replica (originals must be Standard).
    const first = await create(backend, { ...ok, replicaOf: original.backupId });
    await expect(create(backend, { ...ok, replicaOf: original.backupId })).rejects.toMatchObject({ code: 'invalid-replica' });
    await expect(
      create(backend, { ...ok, bytes: first.payloadBytes + 28, replicaOf: first.backupId }),
    ).rejects.toMatchObject({ code: 'invalid-replica' });
    // Once the account is Protected, no replica exemption exists any more.
    const v2Meta = (await backend.getGenerationById(v2.backupId))!;
    await backend.setPrivacyMode('protected');
    await expect(
      create(backend, { bundleFormatVersion: V2, privacyMode: 'protected', bytes: v2Meta.payloadBytes + 28, replicaOf: v2.backupId }),
    ).rejects.toMatchObject({ code: 'invalid-replica' });
    // Nothing forged was committed.
    expect((await backend.listGenerations()).filter((g) => g.replicaOf)).toHaveLength(1);
  });

  it('protects a v1 -> v2 mixed-history account: every replica names its original, latest is the v2 replica', async () => {
    const { source, backend, v1, v2 } = await mixedHistory();
    const mmk = generateMmk();
    const result = await migrateStandardToProtected({ backend, mmk });
    expect(result).toMatchObject({ finalized: true, migrated: 2, resumed: 0, retiredStandard: 2 });
    const latest = (await backend.getLatest())!;
    expect(latest.privacyMode).toBe('protected');
    expect(latest.bundleFormatVersion).toBe(V2);
    expect(latest.replicaOf).toBe(v2.backupId);
    const replicas = await backend.listGenerations();
    expect(replicas.map((g) => g.replicaOf).sort()).toEqual([v1.backupId, v2.backupId].sort());
    const dest = await freshStore();
    await cloudRecover({ stackHome: dest, backend, mmk });
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('an interrupted protect leaves the account Standard and in progress; re-running with the same key resumes and finalizes', async () => {
    const { backend, v1, v2 } = await mixedHistory();
    const mmk = generateMmk();
    // Interrupt after the first replica (the v1 original's) is created.
    let creates = 0;
    const flaky: RemoteMemoryBackend = Object.create(backend);
    flaky.createGeneration = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error('network dropped');
      return backend.createGeneration(input);
    };
    await expect(migrateStandardToProtected({ backend: flaky, mmk })).rejects.toThrow('network dropped');
    expect((await backend.getProfile())?.privacyMode).toBe('standard');
    expect(await isProtectInProgress(backend)).toBe(true);
    expect((await backend.getLatest())?.replicaOf).toBe(v1.backupId);

    const resumed = await migrateStandardToProtected({ backend, mmk });
    expect(resumed).toMatchObject({ finalized: true, migrated: 1, resumed: 1, retiredReplicas: 0, retiredStandard: 2 });
    expect(await isProtectInProgress(backend)).toBe(false);
    expect((await backend.getLatest())?.replicaOf).toBe(v2.backupId);
    expect((await backend.listGenerations()).filter((g) => g.replicaOf === v1.backupId)).toHaveLength(1);
  });

  it('a concurrent push during protect aborts the migration (chained expectedParent) instead of stranding it as Standard', async () => {
    const { source, backend } = await mixedHistory();
    const mmk = generateMmk();
    let creates = 0;
    let concurrentBackupId: string | undefined;
    const racing: RemoteMemoryBackend = Object.create(backend);
    racing.createGeneration = async (input) => {
      const meta = await backend.createGeneration(input);
      creates += 1;
      if (creates === 1) {
        // Another machine's ordinary v2 Standard push lands right after the
        // first replica (it fetched before the replica existed).
        const pushed = await backend.createGeneration({
          backupId: randomUUID(),
          expectedParent: meta.generation,
          privacyMode: 'standard',
          payload: Buffer.from('other machine'),
          bundleFormatVersion: V2,
        });
        concurrentBackupId = pushed.backupId;
      }
      return meta;
    };
    await expect(migrateStandardToProtected({ backend: racing, mmk })).rejects.toMatchObject({ code: 'conflict' });
    expect((await backend.getProfile())?.privacyMode).toBe('standard');
    // Nothing retired: the other machine's Standard push is intact and still latest.
    expect((await backend.getLatest())?.backupId).toBe(concurrentBackupId);
    expect((await backend.listGenerations()).filter((g) => g.privacyMode === 'standard')).toHaveLength(3);
    void source;
  });
});

describe('protect resume from a device WITHOUT the interrupted run\'s key (Task 13 fix round 4)', () => {
  it('retires the orphaned replicas, re-replicates with the new key, and finalizes with the newest original\'s replica as latest', async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    roots.push(source.stackHome);
    const { store, backend } = backendFor('user-a');
    const v1 = await standardCloudBackup({ stackHome: source.stackHome, backend });
    await writeCanonicalMain(source.stackHome, { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] });
    const v2 = await standardCloudBackup({ stackHome: source.stackHome, backend });

    // Device 1 replicates the v1 original, then is interrupted.
    const oldKey = generateMmk();
    let creates = 0;
    const flaky: RemoteMemoryBackend = Object.create(backend);
    flaky.createGeneration = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error('laptop closed');
      return backend.createGeneration(input);
    };
    await expect(migrateStandardToProtected({ backend: flaky, mmk: oldKey })).rejects.toThrow('laptop closed');
    const orphan = (await backend.listGenerations()).find((g) => g.replicaOf === v1.backupId)!;
    expect(orphan).toBeDefined();

    // Device 2 never had that key.
    const newKey = generateMmk();
    const result = await migrateStandardToProtected({ backend, mmk: newKey });
    expect(result).toMatchObject({ finalized: true, migrated: 2, resumed: 0, retiredReplicas: 1, retiredStandard: 2 });
    expect((await backend.getProfile())?.privacyMode).toBe('protected');
    expect(store.hasPayload(`mem/user-a/${orphan.backupId}`)).toBe(false); // orphan retired + purged
    const committed = await backend.listGenerations();
    expect(committed.every((g) => g.privacyMode === 'protected')).toBe(true);
    expect(committed.map((g) => g.replicaOf).sort()).toEqual([v1.backupId, v2.backupId].sort());
    const latest = (await backend.getLatest())!;
    expect(latest.replicaOf).toBe(v2.backupId);
    // Numbers are never reused after a retire (profile-based numbering, like production).
    expect(new Set((store.generations.get('user-a') ?? []).map((g) => g.generation)).size).toBe(
      (store.generations.get('user-a') ?? []).length,
    );
    // Everything opens with the NEW key.
    const dest = await freshStore();
    await cloudRecover({ stackHome: dest, backend, mmk: newKey });
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('uniqueness counts only COMMITTED replicas (matches the SQL partial index `where replica_of is not null and state = \'committed\'`)', async () => {
    const source = await writeSyntheticStore({ projects: 1, filesPerProject: 1 });
    roots.push(source.stackHome);
    const { backend } = backendFor('user-a');
    const std = await standardCloudBackup({ stackHome: source.stackHome, backend });
    const original = (await backend.getGenerationById(std.backupId))!;
    const replica = async () =>
      backend.createGeneration({
        backupId: randomUUID(),
        expectedParent: (await backend.getProfile())?.latestGeneration ?? null,
        privacyMode: 'protected',
        payload: Buffer.alloc(original.payloadBytes + 28, 1),
        bundleFormatVersion: original.bundleFormatVersion,
        replicaOf: original.backupId,
      });
    const first = await replica();
    await expect(replica()).rejects.toMatchObject({ code: 'invalid-replica' }); // a committed one exists
    await backend.retireGeneration(first.backupId);
    const second = await replica(); // retired replicas don't count
    expect(second.replicaOf).toBe(original.backupId);
    expect(second.generation).toBeGreaterThan(first.generation);
  });
});

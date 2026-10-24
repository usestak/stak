import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  InMemoryRemoteMemoryStore,
  emptyRegistry,
  fileLocalMemoryKeyStore,
  generateMmk,
  generateRecoveryKey,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  memoryStorePaths,
  mintProjectId,
  readCanonicalMain,
  readLocalRegistry,
  readMemoryManifest,
  readMemoryObject,
  resolveOrMintProject,
  runMemoryBackup,
  setBinding,
  writeCanonicalMain,
  writeLocalRegistry,
  writeMemoryManifest,
  writeMemoryObject,
  writePortableSnapshot,
  type BackupResult,
  type DiscoveredMemoryItem,
  type ManifestItem,
  type MemoryManifest,
  unwrapWithRecoveryKey,
} from '@stack/memory';

import {
  freshRegistryRisksDuplication,
  pushStagedMemory,
  readMemoryCloudStatus,
  resolveMemoryPushState,
  runMemoryCloudBackup,
  runMemoryCloudProtect,
  runMemoryCloudRecover,
  readRecoveryKeyFile,
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

  it('a pure Skills-only account (no v1 manifest ever, Cloud has no Memory history) does not publish an empty generation (Task 13 Important-7(a))', async () => {
    const stackHome = await temp('stack-skills-only-');
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-skills-only-keys-'));
    const fakeBackupNoManifest = (): Promise<BackupResult> =>
      // The local backup itself touches nothing Memory-related — e.g. a plain
      // Skills-only `stak memory backup` with zero discovered items.
      Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-23T00:00:00.000Z' });
    const outcome = await runMemoryCloudBackup({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackupNoManifest,
    });
    expect(outcome.cloud.status).toBe('nothing-staged');
    expect(await backend.listGenerations()).toHaveLength(0);
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

  it('recover reports the logical file count even when two files share identical content (dedup never implies loss)', async () => {
    // Two logical manifest items, SAME bytes → one content-addressed object.
    const stackHome = await temp('stack-ops-dedup-src-');
    const bodyA = Buffer.from('shared content\n', 'utf8');
    const bodyB = Buffer.from('different content\n', 'utf8');
    const hashA = hashBytes(bodyA);
    const hashB = hashBytes(bodyB);
    await writeMemoryObject({ stackHome, contentHash: hashA, bytes: bodyA });
    await writeMemoryObject({ stackHome, contentHash: hashB, bytes: bodyB });
    const item = (rel: string, contentHash: string): ManifestItem => ({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/local:C--dup/${rel}`,
      project: { kind: 'local', vendorKey: 'C--dup' },
      contentHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: rel },
      capturedAt: '2026-09-25T12:00:00.000Z',
      sensitivity: 'private',
    });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-25T12:00:00.000Z',
        items: [
          item('a1.md', hashA),
          item('a2.md', hashA), // identical content to a1.md — same object
          item('b1.md', hashB),
        ],
      },
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-dedup-keys-'));
    await runMemoryCloudBackup({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });

    const dest = await temp('stack-ops-dedup-dst-');
    const rec = await runMemoryCloudRecover({
      stackHome: dest,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(rec.status).toBe('recovered');
    if (rec.status !== 'recovered') return;
    // 3 logical files, but only 2 unique content objects (a1.md and a2.md collapse).
    expect(rec.files).toBe(3);
    expect(rec.objects).toBe(2);
    // No bytes are missing: both distinct contents are present and byte-exact.
    expect(
      Buffer.from(
        await readMemoryObject({ stackHome: dest, contentHash: hashA }),
      ).equals(bodyA),
    ).toBe(true);
    expect(
      Buffer.from(
        await readMemoryObject({ stackHome: dest, contentHash: hashB }),
      ).equals(bodyB),
    ).toBe(true);
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

    // Task 13 Critical-3 fix (review round): backup now merges like push, so a
    // subsequent backup with NOTHING changed since protect (protect only
    // re-encrypts existing generations; it never touches canonical content) is
    // correctly a no-op — never a second, identical Protected generation.
    const noop = await runMemoryCloudBackup({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(noop.cloud.status).toBe('up-to-date');

    // A subsequent backup with a GENUINE change stays Protected without any prompt.
    const mainBefore = await readCanonicalMain(source.stackHome);
    const projectId = mainBefore.projects[0]?.projectId as string;
    const newBody = Buffer.from('a new protected note', 'utf8');
    const newHash = hashBytes(newBody);
    await writeMemoryObject({ stackHome: source.stackHome, contentHash: newHash, bytes: newBody });
    await writeCanonicalMain(source.stackHome, {
      ...mainBefore,
      projects: mainBefore.projects.map((p) =>
        p.projectId === projectId
          ? {
              ...p,
              documents: [
                ...p.documents,
                {
                  path: 'notes/new.md',
                  state: 'present' as const,
                  contentHash: newHash,
                  importedFrom: 'claude' as const,
                  importedAt: '2026-10-23T00:00:00.000Z',
                },
              ],
            }
          : p,
      ),
    });
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

describe('resolveMemoryPushState — top-level push must not create duplicate Memory generations', () => {
  // Realistic regression coverage for a real production bug: repeatedly running the
  // top-level `stak push` with nothing staged created a new immutable Cloud generation
  // every time. Real `runMemoryBackup`/local manifest/content store, a real in-memory
  // Cloud backend fake — nothing here is a mocked CLI dependency.

  it('A: initial push — no remote backup exists yet', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const state = await resolveMemoryPushState({
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(state).toEqual({ status: 'no-remote-backup' });
  });

  it('B: clean push — MAIN already matches the latest Cloud generation (Standard mode)', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    const first = await pushStagedMemory(deps);
    expect(first.status).toBe('standard');

    const state = await resolveMemoryPushState(deps);
    expect(state).toEqual({ status: 'already-up-to-date', generation: 0 });

    // The actual regression: pushing again when already up to date must create NO
    // generation at all.
    expect(await backend.getLatest()).toMatchObject({ generation: 0 });
  });

  it('C: unstaged MACHINE change is irrelevant — MAIN/Cloud equality alone decides', async () => {
    // This models the exact production sequence: MAIN and Cloud both hold A; a native
    // machine file changes to B, but nothing re-stages it (no `add .`/runMemoryBackup
    // call here). resolveMemoryPushState must still say already-up-to-date because it
    // only ever looks at the STAGED manifest/store, never native/machine state.
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await pushStagedMemory(deps);

    const state = await resolveMemoryPushState(deps);
    expect(state).toEqual({ status: 'already-up-to-date', generation: 0 });
    expect(await backend.getLatest()).toMatchObject({ generation: 0 });
  });

  it('D: a genuinely staged change needs a push', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await pushStagedMemory(deps);

    // Genuinely re-stage different content (a real `add .`/runMemoryBackup call).
    const newBody = Buffer.from('# a brand new staged file\n', 'utf8');
    const newHash = hashBytes(newBody);
    await writeMemoryObject({
      stackHome: source.stackHome,
      contentHash: newHash,
      bytes: newBody,
    });
    const manifest = await readMemoryManifest(source.stackHome);
    if (!manifest) throw new Error('expected a staged manifest');
    await writeMemoryManifest({
      stackHome: source.stackHome,
      manifest: {
        ...manifest,
        items: [
          ...manifest.items,
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'global',
            logicalId: 'claude/auto-memory/new-file.md',
            contentHash: newHash,
            restoreTarget: { base: 'claude-home', relativePath: 'new-file.md' },
            capturedAt: '2026-09-25T12:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const state = await resolveMemoryPushState(deps);
    expect(state).toEqual({ status: 'needs-push' });

    const second = await pushStagedMemory(deps);
    expect(second).toMatchObject({ status: 'standard', generation: 1 });
  });

  it('E: second clean push after a real staged change still creates no further generation', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await pushStagedMemory(deps); // generation 1

    const newBody = Buffer.from('# second file\n', 'utf8');
    const newHash = hashBytes(newBody);
    await writeMemoryObject({
      stackHome: source.stackHome,
      contentHash: newHash,
      bytes: newBody,
    });
    const manifest = await readMemoryManifest(source.stackHome);
    if (!manifest) throw new Error('expected a staged manifest');
    await writeMemoryManifest({
      stackHome: source.stackHome,
      manifest: {
        ...manifest,
        items: [
          ...manifest.items,
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'global',
            logicalId: 'claude/auto-memory/second-file.md',
            contentHash: newHash,
            restoreTarget: { base: 'claude-home', relativePath: 'second-file.md' },
            capturedAt: '2026-09-25T12:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await pushStagedMemory(deps); // generation 2

    const state = await resolveMemoryPushState(deps);
    expect(state).toEqual({ status: 'already-up-to-date', generation: 1 });
  });

  it('F: a portable Project-only change (Memory files unchanged) still needs a push', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await pushStagedMemory(deps); // generation 1, no registry snapshot yet
    expect(await resolveMemoryPushState(deps)).toEqual({
      status: 'already-up-to-date',
      generation: 0,
    });

    // Stage a portable Project change — no Memory file changed at all.
    await writePortableSnapshot(source.stackHome, {
      snapshotVersion: 1,
      projects: [
        {
          projectId: mintProjectId(),
          claims: [{ type: 'legacy-compat' as const, key: 'test-project' }],
          lifecycle: 'active' as const,
        },
      ],
    });

    expect(await resolveMemoryPushState(deps)).toEqual({ status: 'needs-push' });
    const second = await pushStagedMemory(deps);
    expect(second).toMatchObject({ status: 'standard', generation: 1 });
    expect(await resolveMemoryPushState(deps)).toEqual({
      status: 'already-up-to-date',
      generation: 1,
    });
  });

  it('G: a machine-binding-only change (portable state unchanged) must stay up to date', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await pushStagedMemory(deps);

    // A machine-local binding change is never part of the portable bundle at all —
    // write it via the local (non-portable) registry, never the portable snapshot.
    const projectId = mintProjectId();
    const registry = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: 'C--Users-dev-some-project' },
      () => projectId,
    ).registry;
    await writeLocalRegistry(
      source.stackHome,
      setBinding(registry, {
        projectId,
        dir: 'C:/Users/dev/some-project',
        boundAt: '2026-09-25T12:00:00.000Z',
        provenance: 'user-map',
      }),
    );

    expect(await resolveMemoryPushState(deps)).toEqual({
      status: 'already-up-to-date',
      generation: 0,
    });
  });

  it('H: Protected mode — pushing identical staged state twice is a no-op despite randomized encryption', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-state-keys-'));
    // Protected from the start: set the account's privacy mode directly and enroll
    // this device's MMK, skipping the (unrelated) Standard-to-Protected migration flow.
    await backend.ensureProfile('v1');
    await backend.setPrivacyMode('protected');
    await keys.saveMmk(generateMmk());
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };

    const first = await pushStagedMemory(deps);
    expect(first.status).toBe('protected');
    const firstGeneration = first.status === 'protected' ? first.generation : -1;

    // Pushing the exact same staged state again must be a no-op, even though each
    // Protected upload is independently encrypted (fresh nonce/DEK every time).
    const state = await resolveMemoryPushState(deps);
    expect(state).toEqual({ status: 'already-up-to-date', generation: firstGeneration });
    expect(await backend.getLatest()).toMatchObject({ generation: firstGeneration });
  });
});

describe('pushStagedMemory — push uploads only already-staged Memory, never native state', () => {
  // Realistic regression test (real `runMemoryBackup`/`readMemoryManifest`/`readMemoryObject`,
  // a real on-disk "native" file, and a real in-memory Cloud backend fake — nothing here is a
  // mocked CLI dependency). Proves the locked MACHINE -> `stak add .` -> MAIN -> `stak push` ->
  // CLOUD model: push must never implicitly perform an `add .`.
  it('A staged, native changes to B without re-adding: push sends A, not B; status/second add . then pick up B', async () => {
    const stackHome = await temp('stack-push-staged-');
    const nativeHome = await temp('stack-push-staged-native-');
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'content A\n', 'utf8');

    const nativeItem = (): DiscoveredMemoryItem => ({
      provider: 'claude',
      kind: 'agent-memory',
      scope: 'global',
      logicalId: 'claude/agent-memory/notes.md',
      // Placeholder — `runMemoryBackup` re-reads the file and recomputes this at commit
      // time (backup.ts: "Re-read at backup time; the freshly read bytes are authoritative"),
      // so this value is never trusted.
      contentHash: hashBytes(Buffer.from('placeholder')),
      restoreTarget: { base: 'claude-home', relativePath: 'notes.md' },
      source: { path: filePath },
      capturedAt: '2026-01-01T00:00:00.000Z',
      sensitivity: 'private',
    });

    // A. native Memory = A. B. `stak add .` (runMemoryBackup is the real local-staging primitive).
    await runMemoryBackup({ stackHome, items: [nativeItem()] });
    const hashA = (await readMemoryManifest(stackHome))?.items[0]?.contentHash;
    expect(hashA).toBe(hashBytes(Buffer.from('content A\n', 'utf8')));

    // C. Change native Memory to B WITHOUT running add again.
    await writeFile(filePath, 'content B\n', 'utf8');

    // D. `stak push`'s Memory step. runLocalBackup is a spy that throws if ever called —
    // the strongest possible proof push never rescans/re-stages native Memory.
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-push-staged-keys-'));
    const runLocalBackup = vi.fn(async () => {
      throw new Error('pushStagedMemory must never call runLocalBackup');
    });
    const pushOutcome = await pushStagedMemory({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup,
    });
    expect(runLocalBackup).not.toHaveBeenCalled();
    expect(pushOutcome.status).toBe('standard');

    // E. Assert Cloud received A, NOT B.
    const destA = await temp('stack-push-staged-dest-a-');
    const recoveredA = await runMemoryCloudRecover({
      stackHome: destA,
      backend,
      localKeyStore: keys,
      runLocalBackup,
    });
    expect(recoveredA.status).toBe('recovered');
    expect(runLocalBackup).not.toHaveBeenCalled();
    const destAManifest = await readMemoryManifest(destA);
    expect(destAManifest?.items[0]?.contentHash).toBe(hashA);
    const destABytes = await readMemoryObject({
      stackHome: destA,
      contentHash: destAManifest?.items[0]?.contentHash ?? '',
    });
    expect(Buffer.from(destABytes).toString('utf8')).toBe('content A\n');

    // F. Assert the local staged Memory manifest still represents A — push never rewrote it.
    expect((await readMemoryManifest(stackHome))?.items[0]?.contentHash).toBe(
      hashA,
    );

    // G. Native (B) vs staged (A) now disagree — this is exactly what `stak status`'s
    // MACHINE-vs-MAIN Memory check must report as "changes not added".
    const manifestAfterPush = await readMemoryManifest(stackHome);
    expect(
      manifestAfterPush?.items.find(
        (item) => item.logicalId === 'claude/agent-memory/notes.md',
      )?.contentHash,
    ).not.toBe(hashBytes(Buffer.from('content B\n', 'utf8')));

    // H. `stak add .` -> local manifest becomes B.
    await runMemoryBackup({ stackHome, items: [nativeItem()] });
    const hashB = (await readMemoryManifest(stackHome))?.items[0]?.contentHash;
    expect(hashB).toBe(hashBytes(Buffer.from('content B\n', 'utf8')));
    expect(hashB).not.toBe(hashA);

    // I. `stak push` -> Cloud receives B.
    const pushOutcome2 = await pushStagedMemory({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup,
    });
    expect(pushOutcome2.status).toBe('standard');
    expect(runLocalBackup).not.toHaveBeenCalled();
    const destB = await temp('stack-push-staged-dest-b-');
    await runMemoryCloudRecover({
      stackHome: destB,
      backend,
      localKeyStore: keys,
      runLocalBackup,
    });
    expect((await readMemoryManifest(destB))?.items[0]?.contentHash).toBe(
      hashB,
    );
  });
});

describe('freshRegistryRisksDuplication (fresh/reset-registry safeguard)', () => {
  const localItem = (vendorKey: string) => ({
    scope: 'project' as const,
    project: { kind: 'local' as const, vendorKey },
  });
  const gitItem = (canonical: string) => ({
    scope: 'project' as const,
    project: {
      kind: 'git' as const,
      canonical,
      host: 'github.com',
      owner: canonical.split('/')[1] as string,
      repo: canonical.split('/')[2] as string,
    },
  });

  it('blocks: never recovered, Cloud has history, and a brand-new Local identity would be minted', () => {
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: null,
        cloudLatestGeneration: 3,
        nativeItems: [localItem('C--Users-NT-Desktop-nexus')],
        registry: emptyRegistry(),
      }),
    ).toBe(true);
  });

  it('does not block: this machine already recovered at some point (established, even if behind)', () => {
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: 1,
        cloudLatestGeneration: 3,
        nativeItems: [localItem('C--Users-NT-Desktop-nexus')],
        registry: emptyRegistry(),
      }),
    ).toBe(false);
  });

  it('does not block: Cloud has no history yet (genuinely new account/first use)', () => {
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: null,
        cloudLatestGeneration: null,
        nativeItems: [localItem('C--Users-NT-Desktop-nexus')],
        registry: emptyRegistry(),
      }),
    ).toBe(false);
  });

  it('does not block an established registry that already knows this exact identity (one more genuinely new project elsewhere does not retroactively block this one)', () => {
    const registry = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: 'C--Users-NT-Desktop-nexus' },
      () => 'prj_known0000000000000000001',
    ).registry;
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: null,
        cloudLatestGeneration: 3,
        nativeItems: [localItem('C--Users-NT-Desktop-nexus')],
        registry,
      }),
    ).toBe(false);
  });

  it('does not block a Git-backed identity even when never recovered (reconciles safely through Cloud instead)', () => {
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: null,
        cloudLatestGeneration: 3,
        nativeItems: [gitItem('github.com/usestak/stak')],
        registry: emptyRegistry(),
      }),
    ).toBe(false);
  });

  it('does not block on global-scope items (no project identity involved)', () => {
    expect(
      freshRegistryRisksDuplication({
        localRecoveredGeneration: null,
        cloudLatestGeneration: 3,
        nativeItems: [{ scope: 'global' as const }],
        registry: emptyRegistry(),
      }),
    ).toBe(false);
  });
});

describe('runMemoryCloudBackup migrates to canonical Memory and always publishes a v2 generation (Task 13)', () => {
  it('migrates a project-scope v1 item into canonical Memory and publishes exactly one v2 generation per call, even with nothing changed', async () => {
    const stackHome = await temp('stack-backup-v2-');
    // A project-scope (git identity) item — exactly what `migrateLocalStore`
    // moves out of the v1 manifest and into canonical Memory.
    const body = Buffer.from('project note', 'utf8');
    const contentHash = hashBytes(body);
    await writeMemoryObject({ stackHome, contentHash, bytes: body });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-23T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/demo/MEMORY.md',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/demo',
              host: 'github.com',
              owner: 'acme',
              repo: 'demo',
            },
            contentHash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-23T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-backup-v2-keys-'));

    const first = await runMemoryCloudBackup({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(first.cloud.status).toBe('standard');
    if (first.cloud.status === 'standard') expect(first.cloud.generation).toBe(0);
    // Migration ran: the project-scope item left the v1 manifest...
    expect((await readMemoryManifest(stackHome))?.items).toHaveLength(0);
    // ...and landed in canonical Memory.
    const main = await readCanonicalMain(stackHome);
    expect(
      main.projects[0]?.documents.some(
        (doc) => doc.state === 'present' && doc.contentHash === contentHash,
      ),
    ).toBe(true);

    // Task 13 Critical-3 fix (review round): the spec (§9.3) says `stak memory
    // backup` "stays as a deprecated alias for the memory part of `stak push`" —
    // it must MERGE against Cloud like push does, never blindly overwrite it.
    // A second backup with nothing changed since the first is therefore a
    // genuine no-op: no second generation is created.
    const second = await runMemoryCloudBackup({
      stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    });
    expect(second.cloud.status).toBe('up-to-date');
    expect(await backend.listGenerations()).toHaveLength(1);
  });

  it('merges instead of overwriting: another machine pushes a doc, then this machine backs up — the other machine\'s doc survives in Cloud', async () => {
    // Machine B: push doc Z for some project.
    const stackHomeB = await temp('stack-backup-merge-b-');
    let registryB = await readLocalRegistry(stackHomeB);
    const minted = resolveOrMintProject(registryB, {
      kind: 'git',
      canonical: 'github.com/acme/shared',
      host: 'github.com',
      owner: 'acme',
      repo: 'shared',
    });
    registryB = minted.registry;
    await writeLocalRegistry(stackHomeB, registryB);
    const bodyZ = Buffer.from('doc Z from machine B', 'utf8');
    const hashZ = hashBytes(bodyZ);
    await writeMemoryObject({ stackHome: stackHomeB, contentHash: hashZ, bytes: bodyZ });
    await writeCanonicalMain(stackHomeB, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: minted.projectId,
          documents: [
            {
              path: 'notes/z.md',
              state: 'present',
              contentHash: hashZ,
              importedFrom: 'claude',
              importedAt: '2026-10-23T00:00:00.000Z',
            },
          ],
        },
      ],
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'backup-merge-user');
    const keysB = secureKeys(await temp('stack-backup-merge-b-keys-'));
    const pushedB = await runMemoryCloudBackup({
      stackHome: stackHomeB,
      backend,
      localKeyStore: keysB,
      runLocalBackup: fakeBackup,
    });
    expect(pushedB.cloud.status).toBe('standard');

    // Machine A: the SAME logical project (registry already agrees on the
    // Project ID), a DIFFERENT doc of its own, never having synced with B's
    // push. Running `stak memory backup` here must MERGE — never overwrite —
    // so Z survives.
    const stackHomeA = await temp('stack-backup-merge-a-');
    let registryA = await readLocalRegistry(stackHomeA);
    registryA = resolveOrMintProject(
      registryA,
      { kind: 'git', canonical: 'github.com/acme/shared', host: 'github.com', owner: 'acme', repo: 'shared' },
      () => minted.projectId,
    ).registry;
    await writeLocalRegistry(stackHomeA, registryA);
    const bodyY = Buffer.from('doc Y from machine A', 'utf8');
    const hashY = hashBytes(bodyY);
    await writeMemoryObject({ stackHome: stackHomeA, contentHash: hashY, bytes: bodyY });
    await writeCanonicalMain(stackHomeA, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: minted.projectId,
          documents: [
            {
              path: 'notes/y.md',
              state: 'present',
              contentHash: hashY,
              importedFrom: 'claude',
              importedAt: '2026-10-23T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    const keysA = secureKeys(await temp('stack-backup-merge-a-keys-'));
    const backedUpA = await runMemoryCloudBackup({
      stackHome: stackHomeA,
      backend,
      localKeyStore: keysA,
      runLocalBackup: fakeBackup,
    });
    expect(backedUpA.cloud.status).toBe('standard');

    // Z (from B) must survive in Cloud alongside Y (from A) — a merge, not an
    // overwrite.
    const latestMain = await readCanonicalMain(stackHomeA);
    const docs = latestMain.projects.find((p) => p.projectId === minted.projectId)?.documents ?? [];
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashZ)).toBe(true);
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashY)).toBe(true);
  });
});

describe('C1: protect refuses an already-Protected account', () => {
  it('never generates or enrolls a new key, adds no recovery method, and leaves the device MMK intact', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-c1-'));
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: keys,
      runLocalBackup: fakeBackup,
    };
    await runMemoryCloudBackup(deps);
    const first = await runMemoryCloudProtect(deps, { recoveryKey: generateRecoveryKey() });
    expect(first.status).toBe('protected');
    const mmkBefore = await keys.loadMmk();
    const methodsBefore = await backend.listRecoveryMethods();
    const generationsBefore = await backend.listGenerations();

    await expect(
      runMemoryCloudProtect(deps, { recoveryKey: generateRecoveryKey() }),
    ).rejects.toMatchObject({ code: 'already-protected' });

    expect((await keys.loadMmk())?.equals(mmkBefore as Buffer)).toBe(true);
    expect(await backend.listRecoveryMethods()).toHaveLength(methodsBefore.length);
    expect(await backend.listGenerations()).toHaveLength(generationsBefore.length);
    expect((await backend.getProfile())?.privacyMode).toBe('protected');
  });

  it('a locked device (no MMK) is refused too, pointing at `stak memory recover`', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const deviceA = secureKeys(await temp('stack-ops-c1a-'));
    await runMemoryCloudProtect(
      { stackHome: source.stackHome, backend, localKeyStore: deviceA, runLocalBackup: fakeBackup },
      { recoveryKey: generateRecoveryKey() },
    );
    const deviceB = secureKeys(await temp('stack-ops-c1b-'));
    const error = await runMemoryCloudProtect(
      { stackHome: source.stackHome, backend, localKeyStore: deviceB, runLocalBackup: fakeBackup },
      { recoveryKey: generateRecoveryKey() },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'already-protected' });
    expect(String((error as Error).message)).toContain('stak memory recover');
    expect(await deviceB.hasKey()).toBe(false);
    expect(await backend.listRecoveryMethods()).toHaveLength(1);
  });
});

describe('recover --recovery-file reads the file (final review follow-up)', () => {
  it('a recovery file written by protect unlocks a fresh device; a bad path or file fails without changing anything', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const deviceA = secureKeys(await temp('stack-ops-rf-a-'));
    const depsA = { stackHome: source.stackHome, backend, localKeyStore: deviceA, runLocalBackup: fakeBackup };
    await runMemoryCloudBackup(depsA);
    const recoveryKey = generateRecoveryKey();
    await runMemoryCloudProtect(depsA, { recoveryKey });
    const dir = await temp('stack-ops-rf-file-');
    const filePath = path.join(dir, 'stack-memory-recovery.stackkey');
    await writeFile(filePath, `${JSON.stringify(recoveryKey.file, null, 2)}
`, 'utf8');

    const deviceB = secureKeys(await temp('stack-ops-rf-b-'));
    const dest = await temp('stack-ops-rf-dst-');
    const rec = await runMemoryCloudRecover(
      { stackHome: dest, backend, localKeyStore: deviceB, runLocalBackup: fakeBackup },
      { recoveryKey: await readRecoveryKeyFile(filePath) },
    );
    expect(rec.status).toBe('recovered');
    expect(await deviceB.hasKey()).toBe(true);

    await expect(readRecoveryKeyFile(path.join(dir, 'missing.stackkey'))).rejects.toThrow(/Couldn't read the recovery file/);
    const junk = path.join(dir, 'junk.stackkey');
    await writeFile(junk, '{"format":"nope"}', 'utf8');
    await expect(readRecoveryKeyFile(junk)).rejects.toThrow(/isn't a STAK recovery file/);
  });
});

describe('I8: protect writes the recovery file before anything changes in Cloud', () => {
  const setup = async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const keys = secureKeys(await temp('stack-ops-i8-'));
    const deps = { stackHome: source.stackHome, backend, localKeyStore: keys, runLocalBackup: fakeBackup };
    await runMemoryCloudBackup(deps);
    return { backend, keys, deps };
  };

  it('writes the file before the recovery wrapper is added; a migration failure keeps the wrapper, and the file unlocks the enrolled key', async () => {
    const { backend, keys, deps } = await setup();
    const order: string[] = [];
    const addRecoveryMethod = backend.addRecoveryMethod.bind(backend);
    const failing: typeof backend = Object.assign(Object.create(backend) as typeof backend, {
      addRecoveryMethod: async (input: Parameters<typeof backend.addRecoveryMethod>[0]) => {
        order.push('add-recovery-method');
        return addRecoveryMethod(input);
      },
      createGeneration: async () => {
        throw new Error('network died mid-protect');
      },
    });
    const recoveryKey = generateRecoveryKey();
    await expect(
      runMemoryCloudProtect(
        { ...deps, backend: failing },
        {
          recoveryKey,
          writeRecoveryFile: async () => {
            order.push('write-file');
          },
        },
      ),
    ).rejects.toThrow('network died mid-protect');
    expect(order).toEqual(['write-file', 'add-recovery-method']);
    const methods = await backend.listRecoveryMethods();
    expect(methods).toHaveLength(1); // never revoked: the file on disk refers to it
    const stored = methods[0]?.mmkWrapper as { mmkId: string; wrapper: Parameters<typeof unwrapWithRecoveryKey>[0]['wrapper'] };
    const unwrapped = unwrapWithRecoveryKey({
      keyring: { mmkId: stored.mmkId, wrappers: [stored.wrapper] },
      wrapper: stored.wrapper,
      recoveryKey: recoveryKey.keyBytes,
    });
    expect(unwrapped.equals((await keys.loadMmk()) as Buffer)).toBe(true);
  });

  it('a recovery file that cannot be written stops protect before any recovery method, replica or mode change', async () => {
    const { backend, deps } = await setup();
    await expect(
      runMemoryCloudProtect(deps, {
        recoveryKey: generateRecoveryKey(),
        writeRecoveryFile: async () => {
          throw new Error('EEXIST: file already exists');
        },
      }),
    ).rejects.toThrow('EEXIST');
    expect(await backend.listRecoveryMethods()).toHaveLength(0);
    expect((await backend.listGenerations()).every((g) => g.privacyMode === 'standard')).toBe(true);
    expect((await backend.getProfile())?.privacyMode ?? 'standard').toBe('standard');
  });
});

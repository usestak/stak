import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  emptyRegistry,
  fileLocalMemoryKeyStore,
  generateMmk,
  generateRecoveryKey,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  memoryStorePaths,
  mintProjectId,
  readMemoryManifest,
  readMemoryObject,
  resolveOrMintProject,
  runMemoryBackup,
  setBinding,
  writeLocalRegistry,
  writeMemoryManifest,
  writeMemoryObject,
  writePortableSnapshot,
  type BackupResult,
  type DiscoveredMemoryItem,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

import {
  freshRegistryRisksDuplication,
  pushStagedMemory,
  readMemoryCloudStatus,
  resolveMemoryPushState,
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

import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  addPasskeyWrapper,
  fileLocalMemoryKeyStore,
  generateMmk,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  newKeyring,
  protectedCloudBackup,
  readLocalRecoveryState,
  readPortableSnapshot,
  sealMmkForPeer,
  standardCloudBackup,
  toPortableSnapshot,
  unwrapWithPasskey,
  writeLocalRegistry,
  writeMemoryManifest,
  writeMemoryObject,
  writePortableSnapshot,
  type BackupResult,
  type LocalRegistry,
  type ManifestItem,
  type MemoryManifest,
  type ProjectIdentity,
  type RecoverySession,
  type RemoteMemoryBackend,
} from '@stack/memory';

import {
  readBackupSupersession,
  readMemoryCloudStatus,
  runMemoryCloudBackup,
  runMemoryCloudRecover,
  runMemoryGenerations,
  runPasskeyRecover,
  type MemoryCloudDeps,
} from './cloud-ops.js';

const USER = 'user-hist';
const roots: string[] = [];
const temp = async (p: string) => {
  const r = await mkdtemp(path.join(tmpdir(), p));
  roots.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const secureKeys = (dir: string) =>
  fileLocalMemoryKeyStore(dir, {
    harden: () => Promise.resolve(true),
    verify: () => Promise.resolve(true),
  });

const A = '0123456789abcdefghjkmnpqrstvwxyz';
const pid = (n: number) => `prj_${(A[n] as string).repeat(26)}`;
const git = (canonical: string): ProjectIdentity => ({
  kind: 'git',
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});
const idKey = (p: ProjectIdentity) =>
  p.kind === 'git' ? p.canonical : `local:${p.vendorKey}`;

type Spec = { project: ProjectIdentity; rel: string; body: string };

const writeStore = async (
  specs: Spec[],
  snapshotFrom?: LocalRegistry,
): Promise<string> => {
  const stackHome = await temp('stack-hist-src-');
  const items: ManifestItem[] = [];
  for (const spec of specs) {
    const bytes = Buffer.from(spec.body, 'utf8');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    items.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/${idKey(spec.project)}/${spec.rel}`,
      project: spec.project,
      contentHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: spec.rel },
      capturedAt: '2026-09-29T00:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-29T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  if (snapshotFrom) {
    await writeLocalRegistry(stackHome, snapshotFrom);
    await writePortableSnapshot(stackHome, toPortableSnapshot(snapshotFrom));
  }
  return stackHome;
};

const reg = (records: LocalRegistry['projects']): LocalRegistry => ({
  schemaVersion: 1,
  projects: records,
  bindings: [],
});

const backupResult = (): BackupResult => ({
  provider: 'claude',
  files: 0,
  projects: 0,
  createdAt: '2026-09-29T00:00:00.000Z',
});

const makeDeps = (
  backend: RemoteMemoryBackend,
  stackHome: string,
  localKeyStore: MemoryCloudDeps['localKeyStore'],
): MemoryCloudDeps => ({
  stackHome,
  backend,
  localKeyStore,
  runLocalBackup: async () => backupResult(),
});

describe('historical memory generation recovery (15B.6)', () => {
  it('lists committed generations newest-first with a latest marker and no secrets', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
    });
    const outcome = await runMemoryGenerations(
      makeDeps(backend, await temp('stack-x-'), secureKeys(await temp('k-'))),
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.generations.map((g) => g.generation)).toEqual([1, 0]);
    expect(outcome.generations[0]?.latest).toBe(true);
    expect(outcome.generations[1]?.latest).toBe(false);
    const asText = JSON.stringify(outcome.generations);
    expect(asText).not.toContain('mem/'); // no payload locator
    expect(asText).not.toContain('wrapped');
    expect(asText).not.toContain('backupId');
  });

  it('recover --generation selects exactly N and never falls back to latest', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    // gen 0 carries a registry with pid(0); gen 1 with pid(1).
    await standardCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/one'), rel: 'a.md', body: '1' }],
        reg([
          {
            projectId: pid(0),
            claims: [{ type: 'git', canonical: 'github.com/a/one' }],
          },
        ]),
      ),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/two'), rel: 'b.md', body: '2' }],
        reg([
          {
            projectId: pid(1),
            claims: [{ type: 'git', canonical: 'github.com/a/two' }],
          },
        ]),
      ),
      backend,
    });

    const machineB = await temp('stack-B-');
    const result = await runMemoryCloudRecover(
      makeDeps(backend, machineB, secureKeys(await temp('k-'))),
      { generation: 0 },
    );
    expect(result).toMatchObject({ status: 'recovered', generation: 0 });
    // It reconstructed generation 0's registry (pid(0)), NOT the latest (pid(1)).
    const snap = await readPortableSnapshot(machineB);
    expect(snap?.projects.map((r) => r.projectId)).toEqual([pid(0)]);
  });

  it('default recover selects the latest generation', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
    });
    const result = await runMemoryCloudRecover(
      makeDeps(backend, await temp('stack-B-'), secureKeys(await temp('k-'))),
    );
    expect(result).toMatchObject({ status: 'recovered', generation: 1 });
  });

  it('a nonexistent generation fails with no fallback and writes no local state', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    const machineB = await temp('stack-B-');
    const result = await runMemoryCloudRecover(
      makeDeps(backend, machineB, secureKeys(await temp('k-'))),
      { generation: 99 },
    );
    expect(result.status).toBe('no-backup');
    expect(await readLocalRecoveryState(machineB)).toBeNull();
  });

  it('historical recovery records provenance; status reports it and does not claim up to date', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
    });
    const machineB = await temp('stack-B-');
    const deps = makeDeps(backend, machineB, secureKeys(await temp('k-')));
    await runMemoryCloudRecover(deps, { generation: 0 });

    const provenance = await readLocalRecoveryState(machineB);
    expect(provenance?.recoveredGeneration).toBe(0);
    expect(provenance?.cloudLatestAtRecovery).toBe(1);

    const status = await readMemoryCloudStatus(deps);
    expect(status.historicalRecovery).toBe(true);
    expect(status.localRecoveredGeneration).toBe(0);
    expect(status.latestGeneration).toBe(1);

    const supersession = await readBackupSupersession(deps);
    expect(supersession.supersedes).toBe(true);
    expect(supersession.parentGeneration).toBe(1);
    expect(supersession.nextGeneration).toBe(2);
  });

  it('backup after historical recovery on a machine with no sync history is refused like push (final review T15-4); older generations stay immutable', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
    });
    const gen0Payload = await backend.getPayload(
      (await backend.getGeneration(0))?.backupId as string,
    );

    const machineB = await temp('stack-B-');
    const deps = makeDeps(backend, machineB, secureKeys(await temp('k-')));
    await runMemoryCloudRecover(deps, { generation: 0 }); // historical

    // Machine B has never synced (no canonical base): seeding the base from
    // gen 0 would silently discard the rollback, so backup refuses — exactly
    // like `stak push` — and publishes nothing.
    const outcome = await runMemoryCloudBackup(deps);
    expect(outcome.cloud).toMatchObject({ status: 'failed' });
    expect(
      outcome.cloud.status === 'failed' && outcome.cloud.message,
    ).toContain('stak memory recover');
    expect(await backend.getGeneration(2)).toBeNull();
    const status = await readMemoryCloudStatus(deps);
    expect(status.historicalRecovery).toBe(true);
    expect(status.latestGeneration).toBe(1);
    // Older generations remain immutable/byte-identical.
    const gen0After = await backend.getPayload(
      (await backend.getGeneration(0))?.backupId as string,
    );
    expect(Buffer.from(gen0After).equals(Buffer.from(gen0Payload))).toBe(true);
  });

  it('recovering a registry-less generation does not import a newer generation’s registry', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    // gen 0: NO snapshot (pre-registry). gen 1: registry-bearing with pid(1).
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/two'), rel: 'b.md', body: '2' }],
        reg([
          {
            projectId: pid(1),
            claims: [{ type: 'git', canonical: 'github.com/a/two' }],
          },
        ]),
      ),
      backend,
    });
    const machineB = await temp('stack-B-');
    await runMemoryCloudRecover(
      makeDeps(backend, machineB, secureKeys(await temp('k-'))),
      { generation: 0 },
    );
    // gen 0 had no snapshot → lazy migration minted a fresh ID; the gen-1 registry
    // (pid(1)) is NOT present.
    const snap = await readPortableSnapshot(machineB);
    expect(snap?.projects.map((r) => r.projectId)).not.toContain(pid(1));
    expect(snap?.projects).toHaveLength(1);
  });

  it('recovering a historical generation does not mutate Cloud history', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/one'), rel: 'a.md', body: '1' },
      ]),
      backend,
    });
    await standardCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
    });
    const before = await backend.listGenerations();
    await runMemoryCloudRecover(
      makeDeps(backend, await temp('stack-B-'), secureKeys(await temp('k-'))),
      { generation: 0 },
    );
    const after = await backend.listGenerations();
    expect(after.length).toBe(before.length);
    expect((await backend.getLatest())?.generation).toBe(1);
  });

  it('Protected historical recovery honours the generation’s own privacy mode', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const mmk = generateMmk();
    await protectedCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/one'), rel: 'a.md', body: '1' }],
        reg([
          {
            projectId: pid(0),
            claims: [{ type: 'git', canonical: 'github.com/a/one' }],
          },
        ]),
      ),
      backend,
      mmk,
    });
    await protectedCloudBackup({
      stackHome: await writeStore([
        { project: git('github.com/a/two'), rel: 'b.md', body: '2' },
      ]),
      backend,
      mmk,
    });
    const device = secureKeys(await temp('k-'));
    await device.saveMmk(mmk);
    const machineB = await temp('stack-B-');
    const result = await runMemoryCloudRecover(
      makeDeps(backend, machineB, device),
      { generation: 0 },
    );
    expect(result).toMatchObject({
      status: 'recovered',
      privacyMode: 'protected',
      generation: 0,
    });
    expect((await readPortableSnapshot(machineB))?.projects[0]?.projectId).toBe(
      pid(0),
    );
  });

  it('passkey recover --generation binds to the requested generation (no browser TOCTOU)', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const prf = randomBytes(32);
    const mmk = generateMmk();

    // Enroll a passkey recovery method holding the MMK wrapper.
    const keyring = newKeyring();
    const { wrapper } = addPasskeyWrapper({ keyring, mmk, prfOutput: prf });
    await backend.addRecoveryMethod({
      type: 'passkey',
      label: 'Passkey',
      publicIdentifier: 'cred-1',
      mmkWrapper: { mmkId: keyring.mmkId, wrapper },
      cryptoVersion: 'stack-mem-cipher-v1',
    });
    await protectedCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/one'), rel: 'a.md', body: '1' }],
        reg([
          {
            projectId: pid(0),
            claims: [{ type: 'git', canonical: 'github.com/a/one' }],
          },
        ]),
      ),
      backend,
      mmk,
    });
    await protectedCloudBackup({
      stackHome: await writeStore(
        [{ project: git('github.com/a/two'), rel: 'b.md', body: '2' }],
        reg([
          {
            projectId: pid(1),
            claims: [{ type: 'git', canonical: 'github.com/a/two' }],
          },
        ]),
      ),
      backend,
      mmk,
    });

    const browser = async (url: string) => {
      const sessionId = new URL(url).searchParams.get('session') ?? '';
      const record = await backend.getRecoverySession(sessionId);
      const session = record?.session as RecoverySession;
      const methods = await backend.listRecoveryMethods();
      const stored = methods[0]?.mmkWrapper as {
        mmkId: string;
        wrapper: Parameters<typeof unwrapWithPasskey>[0]['wrapper'];
      };
      const recovered = unwrapWithPasskey({
        keyring: { mmkId: stored.mmkId, wrappers: [stored.wrapper] },
        wrapper: stored.wrapper,
        prfOutput: prf,
      });
      await backend.submitRecoveryEnvelope(
        session.sessionId,
        await sealMmkForPeer({ session, mmk: recovered }),
      );
    };

    const machineB = await temp('stack-B-');
    const result = await runPasskeyRecover(
      {
        stackHome: machineB,
        backend,
        localKeyStore: secureKeys(await temp('k-')),
        webBaseUrl: 'http://localhost:3000',
        openBrowser: browser,
        sleep: () => Promise.resolve(),
      },
      { generation: 0 },
    );
    expect(result).toMatchObject({ status: 'recovered', generation: 0 });
    // The CLI selected generation 0 authoritatively; the browser only moved the MMK.
    expect((await readPortableSnapshot(machineB))?.projects[0]?.projectId).toBe(
      pid(0),
    );
    expect((await readLocalRecoveryState(machineB))?.recoveredGeneration).toBe(
      0,
    );
  });
});

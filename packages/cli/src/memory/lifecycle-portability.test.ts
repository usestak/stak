import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  cloudRecover,
  generateMmk,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  lifecycleOf,
  protectedCloudBackup,
  readLocalRegistry,
  readPortableSnapshot,
  resolveProjectForIdentity,
  standardCloudBackup,
  syncRegistryForBackup,
  writeMemoryManifest,
  writeMemoryObject,
  writePortableSnapshot,
  type ManifestItem,
  type MemoryManifest,
  type ProjectIdentity,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { setProjectLifecycle } from './project-ops.js';

const USER = 'user-lifecycle';
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

const git = (canonical: string): ProjectIdentity => ({
  kind: 'git',
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});
const local = (vendorKey: string): ProjectIdentity => ({
  kind: 'local',
  vendorKey,
});
const idKey = (p: ProjectIdentity) =>
  p.kind === 'git' ? p.canonical : `local:${p.vendorKey}`;

type Spec = { project: ProjectIdentity; rel: string; body: string };

const writeStore = async (specs: Spec[]): Promise<string> => {
  const stackHome = await temp('stack-lc-');
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
      capturedAt: '2026-09-30T00:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-30T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return stackHome;
};

const makeBackend = (): RemoteMemoryBackend =>
  inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), USER);

const resolveId = (
  registry: Awaited<ReturnType<typeof readLocalRegistry>>,
  identity: ProjectIdentity,
): string => {
  const r = resolveProjectForIdentity(registry, identity);
  return r.status === 'resolved' ? r.projectId : '';
};

const only = <T>(a: readonly T[]): T => {
  const x = a[0];
  if (x === undefined) throw new Error('expected at least one element');
  return x;
};
const byId = (
  registry: Awaited<ReturnType<typeof readLocalRegistry>>,
  id: string,
) => {
  const r = registry.projects.find((p) => p.projectId === id);
  if (!r) throw new Error(`no project ${id}`);
  return r;
};

/** Mirror `stack memory backup`: sync the portable registry, then upload. */
const backup = async (stackHome: string, backend: RemoteMemoryBackend) => {
  await syncRegistryForBackup({ stackHome });
  await standardCloudBackup({ stackHome, backend });
};

describe('project lifecycle portability (15C)', () => {
  it('archive is local-only until backup, then travels to a fresh machine (no binding)', async () => {
    const backend = makeBackend();
    const machineA = await writeStore([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
      { project: local('C--old-nexus'), rel: 'n.md', body: 'N' },
    ]);
    await backup(machineA, backend); // backup #0 — both active

    // Archive nexus locally.
    const regA = await readLocalRegistry(machineA);
    const nexusId = resolveId(regA, local('C--old-nexus'));
    await setProjectLifecycle({
      stackHome: machineA,
      selector: nexusId,
      lifecycle: 'archived',
    });

    // #31: the change is local-only — the previously committed backup #0 snapshot
    // is still all-active (an immutable prior backup is not mutated).
    const gen0Payload = await backend.getPayload(
      (await backend.getGeneration(0))?.backupId as string,
    );
    expect(Buffer.from(gen0Payload).toString('utf8')).not.toContain('archived');

    // #26: a new backup snapshots the archived lifecycle into the portable registry.
    await backup(machineA, backend); // backup #1 — nexus archived
    const snapA = await readPortableSnapshot(machineA);
    expect(
      snapA?.projects.find((p) => p.projectId === nexusId)?.lifecycle,
    ).toBe('archived');

    // #27/#28/#32: fresh machine recovers latest → nexus archived, no binding.
    const machineB = await temp('stack-B-');
    await cloudRecover({ stackHome: machineB, backend });
    const regB = await readLocalRegistry(machineB);
    expect(regB.bindings).toEqual([]);
    expect(lifecycleOf(byId(regB, nexusId))).toBe('archived');
    // Atlas remained active.
    const atlasId = resolveId(regB, git('github.com/acme/atlas'));
    expect(lifecycleOf(byId(regB, atlasId))).toBe('active');
  });

  it('#30 historical recovery reproduces the lifecycle from THAT backup, not the latest', async () => {
    const backend = makeBackend();
    const machineA = await writeStore([
      { project: local('C--nexus'), rel: 'n.md', body: 'N' },
    ]);
    await backup(machineA, backend); // #0: active
    const nexusId = resolveId(
      await readLocalRegistry(machineA),
      local('C--nexus'),
    );
    await setProjectLifecycle({
      stackHome: machineA,
      selector: nexusId,
      lifecycle: 'archived',
    });
    await backup(machineA, backend); // #1: archived

    // Recover backup #0 → active.
    const b0 = await temp('stack-b0-');
    await cloudRecover({ stackHome: b0, backend, generation: 0 });
    expect(lifecycleOf(only((await readLocalRegistry(b0)).projects))).toBe(
      'active',
    );

    // Recover latest (#1) → archived.
    const b1 = await temp('stack-b1-');
    await cloudRecover({ stackHome: b1, backend });
    expect(lifecycleOf(only((await readLocalRegistry(b1)).projects))).toBe(
      'archived',
    );
  });

  it('recovered backup is authoritative: historical recovery overrides local lifecycle and keeps the local binding', async () => {
    const backend = makeBackend();
    const machineA = await writeStore([
      { project: local('C--nexus'), rel: 'n.md', body: 'N' },
    ]);
    await backup(machineA, backend); // #0: active
    const nexusId = resolveId(
      await readLocalRegistry(machineA),
      local('C--nexus'),
    );
    await setProjectLifecycle({
      stackHome: machineA,
      selector: nexusId,
      lifecycle: 'archived',
    });
    await backup(machineA, backend); // #1: archived

    // Machine C recovers the latest (#1) → archived, establishing local state,
    // then maps a machine-local binding.
    const machineC = await temp('stack-C-');
    await cloudRecover({ stackHome: machineC, backend });
    expect(lifecycleOf(byId(await readLocalRegistry(machineC), nexusId))).toBe(
      'archived',
    );
    const nexusDir = await temp('nexus-C-');
    const { mapProject } = await import('./project-ops.js');
    await mapProject({
      stackHome: machineC,
      selector: nexusId,
      dir: nexusDir,
      gitOrigin: async () => undefined,
    });
    const boundBefore = (await readLocalRegistry(machineC)).bindings;
    expect(boundBefore).toHaveLength(1);

    // Deliberately recover the OLDER backup #0 (active) onto the SAME machine, whose
    // local working state currently says archived.
    await cloudRecover({ stackHome: machineC, backend, generation: 0 });
    const afterOld = await readLocalRegistry(machineC);
    // Portable lifecycle follows the selected backup (#0 = active), NOT local state.
    expect(lifecycleOf(byId(afterOld, nexusId))).toBe('active');
    // The machine-local binding is untouched across the recovery.
    expect(afterOld.bindings).toEqual(boundBefore);

    // Recovering the newer backup (#1) again flips lifecycle back to archived,
    // proving the selected backup — not local state — decides each time.
    await cloudRecover({ stackHome: machineC, backend, generation: 1 });
    const afterNew = await readLocalRegistry(machineC);
    expect(lifecycleOf(byId(afterNew, nexusId))).toBe('archived');
    expect(afterNew.bindings).toEqual(boundBefore);
  });

  it('#29 a pre-lifecycle backup recovers projects as active', async () => {
    const backend = makeBackend();
    const machineA = await writeStore([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
    ]);
    // Snapshot WITHOUT a lifecycle field (pre-15C shape).
    await writePortableSnapshot(machineA, {
      snapshotVersion: 1,
      projects: [
        {
          projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
    });
    await standardCloudBackup({ stackHome: machineA, backend });

    const machineB = await temp('stack-B-');
    await cloudRecover({ stackHome: machineB, backend });
    const record = only((await readLocalRegistry(machineB)).projects);
    expect(record.lifecycle).toBeUndefined();
    expect(lifecycleOf(record)).toBe('active');
  });

  it('#23/#24/#25 archiving does not drop any Memory from the backup', async () => {
    const backend = makeBackend();
    const machineA = await writeStore([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
      { project: local('C--nexus'), rel: 'n1.md', body: 'N1' },
      { project: local('C--nexus'), rel: 'n2.md', body: 'N2' },
    ]);
    await backup(machineA, backend);
    const nexusId = resolveId(
      await readLocalRegistry(machineA),
      local('C--nexus'),
    );
    await setProjectLifecycle({
      stackHome: machineA,
      selector: nexusId,
      lifecycle: 'archived',
    });
    await backup(machineA, backend);

    // Fresh recover → all 3 files present regardless of archived lifecycle.
    const machineB = await temp('stack-B-');
    const recovered = await cloudRecover({ stackHome: machineB, backend });
    expect(recovered.objects).toBe(3);
    const { readMemoryManifest } = await import('@stack/memory');
    expect((await readMemoryManifest(machineB))?.items).toHaveLength(3);
  });

  it('#33/#34 lifecycle travels under Protected exactly as under Standard', async () => {
    const backend = makeBackend();
    const mmk = generateMmk();
    const machineA = await writeStore([
      { project: local('C--nexus'), rel: 'n.md', body: 'N' },
    ]);
    await syncRegistryForBackup({ stackHome: machineA });
    await protectedCloudBackup({ stackHome: machineA, backend, mmk });
    const nexusId = resolveId(
      await readLocalRegistry(machineA),
      local('C--nexus'),
    );
    await setProjectLifecycle({
      stackHome: machineA,
      selector: nexusId,
      lifecycle: 'archived',
    });
    await syncRegistryForBackup({ stackHome: machineA });
    await protectedCloudBackup({ stackHome: machineA, backend, mmk });

    // Protected ciphertext must not expose the lifecycle in plaintext.
    const latest = await backend.getLatest();
    const payload = await backend.getPayload(latest?.backupId as string);
    expect(Buffer.from(payload).toString('utf8')).not.toContain('archived');

    const machineB = await temp('stack-B-');
    await cloudRecover({ stackHome: machineB, backend, mmk });
    expect(
      lifecycleOf(only((await readLocalRegistry(machineB)).projects)),
    ).toBe('archived');
  });

  it('synthetic Machine J → K acceptance', async () => {
    const backend = makeBackend();
    // Machine J: Atlas (git), Stack (local, will be mapped), Nexus (local, unavailable).
    const machineJ = await writeStore([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
      { project: local('C--J-stack'), rel: 's.md', body: 'S' },
      { project: local('C--J-nexus'), rel: 'n.md', body: 'N' },
    ]);
    await backup(machineJ, backend);
    const regJ = await readLocalRegistry(machineJ);
    const nexusId = resolveId(regJ, local('C--J-nexus'));

    // Archive Nexus, then map it to a real directory on J.
    await setProjectLifecycle({
      stackHome: machineJ,
      selector: nexusId,
      lifecycle: 'archived',
    });
    const nexusDir = await temp('nexus-J-');
    const { mapProject } = await import('./project-ops.js');
    await mapProject({
      stackHome: machineJ,
      selector: nexusId,
      dir: nexusDir,
      gitOrigin: async () => undefined,
    });
    await backup(machineJ, backend); // capture archived lifecycle

    // Fresh Machine K recovers latest.
    const machineK = await temp('stack-K-');
    await cloudRecover({ stackHome: machineK, backend });
    const regK = await readLocalRegistry(machineK);
    // Same Nexus Project ID, archived lifecycle, and NO Machine J binding crossed.
    expect(regK.projects.some((p) => p.projectId === nexusId)).toBe(true);
    expect(lifecycleOf(byId(regK, nexusId))).toBe('archived');
    expect(regK.bindings).toEqual([]);

    // Unarchive on K → active; a fresh backup carries active to a third machine.
    await setProjectLifecycle({
      stackHome: machineK,
      selector: nexusId,
      lifecycle: 'active',
    });
    await backup(machineK, backend);
    const machineL = await temp('stack-L-');
    await cloudRecover({ stackHome: machineL, backend });
    const regL = await readLocalRegistry(machineL);
    expect(lifecycleOf(byId(regL, nexusId))).toBe('active');
    expect(regL.bindings).toEqual([]);
  });
});

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
  planMemoryBackupComposition,
  protectedCloudBackup,
  readLocalRegistry,
  readMemoryManifest,
  resolveProjectForIdentity,
  runMemoryBackup,
  standardCloudBackup,
  syncRegistryForBackup,
  writeMemoryManifest,
  writeMemoryObject,
  type LocalRegistry,
  type ManifestItem,
  type MemoryManifest,
  type ProjectIdentity,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { setProjectLifecycle } from './project-ops.js';

const roots: string[] = [];
const temp = async (prefix: string) => {
  const r = await mkdtemp(path.join(tmpdir(), prefix));
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
const keyOf = (p: ProjectIdentity) =>
  p.kind === 'git' ? p.canonical : `local:${p.vendorKey}`;

const ATLAS = git('github.com/acme/atlas');
const NEXUS = local('C--old-nexus');

type Spec = { project: ProjectIdentity; rel: string; body: string };

/** The Machine-J shape: 27 files across 9 projects (Atlas 7, Nexus 4, 7 others 16). */
const machineJSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  for (let i = 1; i <= 7; i += 1)
    specs.push({ project: ATLAS, rel: `a${i}.md`, body: `atlas-${i}` });
  for (let i = 1; i <= 4; i += 1)
    specs.push({ project: NEXUS, rel: `n${i}.md`, body: `nexus-${i}` });
  [3, 3, 2, 2, 2, 2, 2].forEach((count, p) => {
    for (let i = 1; i <= count; i += 1)
      specs.push({
        project: local(`C--old-p${p}`),
        rel: `p${p}-${i}.md`,
        body: `p${p}-${i}`,
      });
  });
  return specs;
};

/** Seed a recovered-machine private store with the 27-file baseline manifest. */
const seedMachine = async (): Promise<{
  stackHome: string;
  registry: LocalRegistry;
}> => {
  const stackHome = await temp('stack-J-');
  const items: ManifestItem[] = [];
  for (const spec of machineJSpecs()) {
    const bytes = Buffer.from(spec.body, 'utf8');
    await writeMemoryObject({
      stackHome,
      contentHash: hashBytes(bytes),
      bytes,
    });
    items.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/${keyOf(spec.project)}/${spec.rel}`,
      project: spec.project,
      contentHash: hashBytes(bytes),
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
  const { registry } = await syncRegistryForBackup({ stackHome });
  return { stackHome, registry };
};

const idOf = (registry: LocalRegistry, identity: ProjectIdentity): string => {
  const r = resolveProjectForIdentity(registry, identity);
  if (r.status !== 'resolved') throw new Error('unresolved');
  return r.projectId;
};

const lifecycleById = (registry: LocalRegistry, projectId: string) => {
  const record = registry.projects.find((r) => r.projectId === projectId);
  if (!record) throw new Error(`no project ${projectId}`);
  return lifecycleOf(record);
};

/**
 * Compose the NEXT backup exactly as `stack memory backup` does (preservation-first),
 * with Atlas available via a Git checkout candidate but ZERO native Memory observed.
 */
const composeAndCommit = async (stackHome: string) => {
  const registry = await readLocalRegistry(stackHome);
  const composition = await planMemoryBackupComposition({
    stackHome,
    nativeItems: [], // native scan reports 0 (recovered, not yet restored)
    registry,
    projects: [
      {
        dir: await temp('atlas-checkout-'),
        gitRemote: 'https://github.com/acme/atlas.git',
      },
    ],
  });
  await runMemoryBackup({
    stackHome,
    items: [],
    carryForward: composition.carriedForward,
  });
  await syncRegistryForBackup({ stackHome });
  return composition;
};

describe('synthetic Machine-J backup preservation acceptance (15C.1)', () => {
  it('Standard: a recovered machine (27 files, native 0) backs up all 27 and a fresh machine recovers them', async () => {
    const backend: RemoteMemoryBackend = inMemoryRemoteMemoryBackend(
      new InMemoryRemoteMemoryStore(),
      'user-J-standard',
    );
    const { stackHome, registry } = await seedMachine();
    // Archive Nexus locally (metadata only).
    await setProjectLifecycle({
      stackHome,
      selector: idOf(registry, NEXUS),
      lifecycle: 'archived',
    });

    // Dry-run preview proves preservation (9 projects, 27 files — NOT 8 / 20).
    const preview = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry: await readLocalRegistry(stackHome),
      projects: [
        {
          dir: await temp('atlas-'),
          gitRemote: 'https://github.com/acme/atlas.git',
        },
      ],
    });
    expect(preview.finalFiles).toBe(27);
    expect(preview.finalProjects).toBe(9);
    expect(preview.nativeFiles).toBe(0);
    expect(preview.availableProjects).toBe(1); // Atlas resolves; the rest are unavailable
    expect(preview.retainedAvailableFiles).toBe(7); // Atlas, preserved though not native
    expect(preview.retainedUnavailableFiles).toBe(20);

    // Real backup composes + commits the same 27, then uploads.
    await composeAndCommit(stackHome);
    expect((await readMemoryManifest(stackHome))?.items).toHaveLength(27);
    await standardCloudBackup({ stackHome, backend });

    // Fresh Machine K recovers latest.
    const machineK = await temp('stack-K-');
    const recovered = await cloudRecover({ stackHome: machineK, backend });
    expect(recovered.objects).toBe(27);
    const manifestK = await readMemoryManifest(machineK);
    expect(manifestK?.items).toHaveLength(27);
    const regK = await readLocalRegistry(machineK);
    expect(regK.projects).toHaveLength(9);
    expect(regK.bindings).toEqual([]);
    // Atlas identity preserved; Nexus same Project ID + archived lifecycle.
    expect(
      regK.projects.some((r) =>
        r.claims.some(
          (c) => c.type === 'git' && c.canonical === 'github.com/acme/atlas',
        ),
      ),
    ).toBe(true);
    const nexusId = idOf(regK, NEXUS);
    expect(nexusId).toBe(idOf(await readLocalRegistry(stackHome), NEXUS));
    expect(lifecycleById(regK, nexusId)).toBe('archived');
  });

  it('Protected: identical preservation semantics through encryption', async () => {
    const backend: RemoteMemoryBackend = inMemoryRemoteMemoryBackend(
      new InMemoryRemoteMemoryStore(),
      'user-J-protected',
    );
    const mmk = generateMmk();
    const { stackHome, registry } = await seedMachine();
    await setProjectLifecycle({
      stackHome,
      selector: idOf(registry, NEXUS),
      lifecycle: 'archived',
    });
    await composeAndCommit(stackHome);
    expect((await readMemoryManifest(stackHome))?.items).toHaveLength(27);
    await protectedCloudBackup({ stackHome, backend, mmk });

    // Ciphertext must not expose Memory or lifecycle in plaintext.
    const latest = await backend.getLatest();
    const payload = await backend.getPayload(latest?.backupId as string);
    const text = Buffer.from(payload).toString('utf8');
    expect(text).not.toContain('archived');
    expect(text).not.toContain('nexus-1');

    const machineK = await temp('stack-K-');
    const recovered = await cloudRecover({ stackHome: machineK, backend, mmk });
    expect(recovered.objects).toBe(27);
    expect((await readMemoryManifest(machineK))?.items).toHaveLength(27);
    const regK = await readLocalRegistry(machineK);
    expect(regK.projects).toHaveLength(9);
    expect(regK.bindings).toEqual([]);
    const nexusId = idOf(regK, NEXUS);
    expect(lifecycleById(regK, nexusId)).toBe('archived');
  });
});

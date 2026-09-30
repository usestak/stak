import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { planMemoryBackupComposition, runMemoryBackup } from './backup.js';
import type {
  DiscoveredMemoryItem,
  ManifestItem,
  MemoryManifest,
  ProjectIdentity,
} from './domain.js';
import {
  setLifecycle,
  resolveProjectForIdentity,
  type LocalRegistry,
} from './project/registry.js';
import {
  readLocalRegistry,
  syncRegistryForBackup,
} from './project/registry-store.js';
import {
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  type RemoteMemoryBackend,
} from './remote/backend.js';
import { standardCloudBackup } from './remote/modes.js';
import {
  hashBytes,
  memoryStorePaths,
  readMemoryManifest,
  readMemoryObject,
  writeMemoryManifest,
  writeMemoryObject,
} from './store.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
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

type Spec = { project: ProjectIdentity; rel: string; body: string };

const manifestItemOf = (spec: Spec): ManifestItem => ({
  provider: 'claude',
  kind: 'auto-memory',
  scope: 'project',
  logicalId: `claude/auto-memory/${keyOf(spec.project)}/${spec.rel}`,
  project: spec.project,
  contentHash: hashBytes(Buffer.from(spec.body, 'utf8')),
  restoreTarget: { base: 'claude-project-memory', relativePath: spec.rel },
  capturedAt: '2026-09-30T00:00:00.000Z',
  sensitivity: 'private',
});

/** Seed a private store with a baseline manifest + its objects, then sync the registry. */
const seedBaseline = async (
  specs: Spec[],
): Promise<{ stackHome: string; registry: LocalRegistry }> => {
  const stackHome = await tempDir('stack-preserve-');
  const items: ManifestItem[] = [];
  for (const spec of specs) {
    const bytes = Buffer.from(spec.body, 'utf8');
    await writeMemoryObject({
      stackHome,
      contentHash: hashBytes(bytes),
      bytes,
    });
    items.push(manifestItemOf(spec));
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-30T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  let counter = 0;
  const { registry } = await syncRegistryForBackup({
    stackHome,
    mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
  });
  return { stackHome, registry };
};

/** A native (freshly discovered) item backed by a real temp file. */
const nativeItem = async (spec: Spec): Promise<DiscoveredMemoryItem> => {
  const dir = await tempDir('native-');
  const file = path.join(dir, spec.rel);
  await writeFile(file, spec.body, 'utf8');
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${keyOf(spec.project)}/${spec.rel}`,
    project: spec.project,
    contentHash: hashBytes(Buffer.from(spec.body, 'utf8')),
    restoreTarget: { base: 'claude-project-memory', relativePath: spec.rel },
    source: { path: file },
    capturedAt: '2026-09-30T00:00:00.000Z',
    sensitivity: 'private',
  };
};

/**
 * The synthetic Machine-J baseline: 27 files across 9 projects.
 *  - Atlas: git, 7 files (will be available via a Git candidate).
 *  - Nexus: local, 4 files (will be archived + unavailable).
 *  - 7 other local projects: 16 files (unavailable).
 */
const ATLAS = git('github.com/acme/atlas');
const NEXUS = local('C--old-nexus');
const machineJSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  for (let i = 1; i <= 7; i += 1)
    specs.push({ project: ATLAS, rel: `a${i}.md`, body: `atlas-${i}` });
  for (let i = 1; i <= 4; i += 1)
    specs.push({ project: NEXUS, rel: `n${i}.md`, body: `nexus-${i}` });
  // 7 other projects: 3,3,2,2,2,2,2 = 16 files.
  const counts = [3, 3, 2, 2, 2, 2, 2];
  counts.forEach((count, p) => {
    for (let i = 1; i <= count; i += 1)
      specs.push({
        project: local(`C--old-p${p}`),
        rel: `p${p}-${i}.md`,
        body: `p${p}-${i}`,
      });
  });
  return specs; // 7 + 4 + 16 = 27, across 9 projects
};

const idOf = (registry: LocalRegistry, identity: ProjectIdentity): string => {
  const r = resolveProjectForIdentity(registry, identity);
  if (r.status !== 'resolved')
    throw new Error(`expected ${keyOf(identity)} to resolve`);
  return r.projectId;
};

/** Atlas resolves via a live Git checkout candidate (available, cwd-independent). */
const atlasCandidate = async () => ({
  dir: await tempDir('atlas-checkout-'),
  gitRemote: 'https://github.com/acme/atlas.git',
});

/* -------------------------------------------------------------------------- */
/* Composition preservation (Phase 15C.1)                                       */
/* -------------------------------------------------------------------------- */

describe('backup preservation composition (15C.1)', () => {
  it('#1/#7/G baseline 27 + native 0 → final 27 (nothing dropped)', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    expect(composition.nativeFiles).toBe(0);
    expect(composition.retainedFiles).toBe(27);
    expect(composition.finalFiles).toBe(27);
    expect(composition.finalProjects).toBe(9);
  });

  it('#2/#4/#6/G available project (Atlas) with native 0 keeps all its Memory', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    // Atlas is available on this machine but not present natively → retained.
    expect(composition.availableProjects).toBe(1);
    expect(composition.retainedAvailableFiles).toBe(7);
    expect(composition.retainedUnavailableFiles).toBe(20);
    const atlasRetained = composition.carriedForward.filter((i) =>
      i.logicalId.includes('github.com/acme/atlas'),
    );
    expect(atlasRetained).toHaveLength(7);
  });

  it('#3 unavailable project retains previous Memory', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    const nexusRetained = composition.carriedForward.filter((i) =>
      i.logicalId.includes('C--old-nexus'),
    );
    expect(nexusRetained).toHaveLength(4);
  });

  it('#8/CASE B baseline 27 + identical native 7 (Atlas) → final 27, no duplicates', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const nativeItems = [];
    for (let i = 1; i <= 7; i += 1)
      nativeItems.push(
        await nativeItem({
          project: ATLAS,
          rel: `a${i}.md`,
          body: `atlas-${i}`,
        }),
      );
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      projects: [await atlasCandidate()],
    });
    expect(composition.nativeFiles).toBe(7);
    expect(composition.retainedFiles).toBe(20); // 27 - 7 overlaid
    expect(composition.finalFiles).toBe(27);
    // No logical id appears twice in the final composition.
    const finalIds = [
      ...composition.native.map((i) => i.logicalId),
      ...composition.carriedForward.map((i) => i.logicalId),
    ];
    expect(new Set(finalIds).size).toBe(finalIds.length);
  });

  it('#9/#12/CASE C one changed native Atlas item wins by logical id → final 27', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const nativeItems = [];
    for (let i = 1; i <= 7; i += 1)
      nativeItems.push(
        await nativeItem({
          project: ATLAS,
          rel: `a${i}.md`,
          // a1 changed; a2..a7 identical.
          body: i === 1 ? 'atlas-1-CHANGED' : `atlas-${i}`,
        }),
      );
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      projects: [await atlasCandidate()],
    });
    expect(composition.finalFiles).toBe(27);
    // a1 is native (not carried), and its new content wins after a real backup.
    expect(
      composition.carriedForward.some((i) => i.logicalId.endsWith('a1.md')),
    ).toBe(false);
    await runMemoryBackup({
      stackHome,
      items: nativeItems,
      carryForward: composition.carriedForward,
    });
    const manifest = await readMemoryManifest(stackHome);
    const a1 = manifest?.items.find((i) => i.logicalId.endsWith('a1.md'));
    expect(a1?.contentHash).toBe(hashBytes(Buffer.from('atlas-1-CHANGED')));
    expect(manifest?.items).toHaveLength(27);
  });

  it('#10/CASE D only 6 of 7 native Atlas files → the 7th is retained, final 27', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const nativeItems = [];
    for (let i = 1; i <= 6; i += 1)
      nativeItems.push(
        await nativeItem({
          project: ATLAS,
          rel: `a${i}.md`,
          body: `atlas-${i}`,
        }),
      );
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      projects: [await atlasCandidate()],
    });
    expect(composition.nativeFiles).toBe(6);
    expect(composition.finalFiles).toBe(27);
    // The missing 7th Atlas file is retained, not silently deleted.
    expect(
      composition.carriedForward.some((i) => i.logicalId.endsWith('a7.md')),
    ).toBe(true);
  });

  it('#11/CASE E a genuinely new native Atlas item is added → final 28', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const nativeItems = [];
    for (let i = 1; i <= 7; i += 1)
      nativeItems.push(
        await nativeItem({
          project: ATLAS,
          rel: `a${i}.md`,
          body: `atlas-${i}`,
        }),
      );
    nativeItems.push(
      await nativeItem({ project: ATLAS, rel: 'a8.md', body: 'atlas-8-NEW' }),
    );
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      projects: [await atlasCandidate()],
    });
    expect(composition.nativeFiles).toBe(8);
    expect(composition.finalFiles).toBe(28);
  });

  it('#5/#20/#21/CASE F archived lifecycle (available or not) does not affect retention', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    // Archive Nexus (unavailable) and Atlas (available) — lifecycle is registry state.
    const nexusId = idOf(registry, NEXUS);
    const atlasId = idOf(registry, ATLAS);
    let archived = setLifecycle(registry, nexusId, 'archived');
    archived = setLifecycle(archived, atlasId, 'archived');
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry: archived,
      projects: [await atlasCandidate()],
    });
    // Lifecycle is irrelevant to composition: still all 27 retained.
    expect(composition.finalFiles).toBe(27);
    expect(composition.retainedFiles).toBe(27);
  });

  it('#18/#19 project identity safety: no duplicate Atlas identity, stable ids', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    // Two native Atlas files by the SAME Git identity.
    const nativeItems = [
      await nativeItem({ project: ATLAS, rel: 'a1.md', body: 'atlas-1' }),
      await nativeItem({ project: ATLAS, rel: 'a2.md', body: 'atlas-2' }),
    ];
    await runMemoryBackup({
      stackHome,
      items: nativeItems,
      carryForward: (
        await planMemoryBackupComposition({
          stackHome,
          nativeItems,
          registry,
          projects: [await atlasCandidate()],
        })
      ).carriedForward,
    });
    await syncRegistryForBackup({ stackHome });
    const after = await readLocalRegistry(stackHome);
    // Exactly one Atlas (git) project — native overlay never mints a duplicate.
    const atlasProjects = after.projects.filter((r) =>
      r.claims.some(
        (c) => c.type === 'git' && c.canonical === 'github.com/acme/atlas',
      ),
    );
    expect(atlasProjects).toHaveLength(1);
    expect(after.projects).toHaveLength(9);
  });

  it('#17 retained unchanged items preserve their exact hashes/content', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    await runMemoryBackup({
      stackHome,
      items: [],
      carryForward: composition.carriedForward,
    });
    const manifest = await readMemoryManifest(stackHome);
    const n1 = manifest?.items.find((i) => i.logicalId.endsWith('n1.md'));
    expect(n1?.contentHash).toBe(hashBytes(Buffer.from('nexus-1')));
    const bytes = await readMemoryObject({
      stackHome,
      contentHash: n1?.contentHash as string,
    });
    expect(Buffer.from(bytes).toString('utf8')).toBe('nexus-1');
  });

  it('#13/#14 dry-run and real backup use identical composition; dry-run mutates nothing', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const before = await readFile(memoryStorePaths(stackHome).currentManifest);
    const nativeItems = [
      await nativeItem({ project: ATLAS, rel: 'a1.md', body: 'atlas-1' }),
    ];
    const preview = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      projects: [await atlasCandidate()],
    });
    // Dry-run wrote nothing.
    expect(
      (await readFile(memoryStorePaths(stackHome).currentManifest)).equals(
        before,
      ),
    ).toBe(true);
    // Real backup applies exactly the previewed composition.
    const result = await runMemoryBackup({
      stackHome,
      items: nativeItems,
      carryForward: preview.carriedForward,
    });
    expect(result.files).toBe(preview.finalFiles);
    expect(result.files).toBe(27);
  });

  it('#15 a successful backup persists the composed manifest locally (27)', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const preview = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    await runMemoryBackup({
      stackHome,
      items: [],
      carryForward: preview.carriedForward,
    });
    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items).toHaveLength(27);
  });

  it('#16 a Cloud failure never leaves a pruned local manifest', async () => {
    const { stackHome, registry } = await seedBaseline(machineJSpecs());
    const preview = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      projects: [await atlasCandidate()],
    });
    // Local composition happens first (full 27), then Cloud upload.
    await runMemoryBackup({
      stackHome,
      items: [],
      carryForward: preview.carriedForward,
    });
    await syncRegistryForBackup({ stackHome });
    // A backend whose Cloud upload fails (createGeneration throws); everything else
    // behaves like the real in-memory backend.
    const real = inMemoryRemoteMemoryBackend(
      new InMemoryRemoteMemoryStore(),
      'user-preserve',
    );
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'createGeneration')
          return async () => {
            throw new Error('cloud upload failed');
          };
        return Reflect.get(target, prop, receiver);
      },
    }) as RemoteMemoryBackend;
    await expect(
      standardCloudBackup({ stackHome, backend: failing }),
    ).rejects.toThrow('cloud upload failed');
    // The local manifest is intact and complete — nothing was pruned.
    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items).toHaveLength(27);
  });
});

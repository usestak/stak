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
import { encodeClaudeProjectKey } from './project-identity.js';
import { setBinding, type LocalRegistry } from './project/registry.js';
import { syncRegistryForBackup } from './project/registry-store.js';
import {
  hashBytes,
  readMemoryManifest,
  writeMemoryManifest,
  writeMemoryObject,
} from './store.js';

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

type Spec = { project: ProjectIdentity; rel: string; body: string };

const manifestItemOf = (spec: Spec): ManifestItem => {
  const contentHash = hashBytes(Buffer.from(spec.body, 'utf8'));
  const key =
    spec.project.kind === 'git'
      ? spec.project.canonical
      : `local:${spec.project.vendorKey}`;
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${key}/${spec.rel}`,
    project: spec.project,
    contentHash,
    restoreTarget: { base: 'claude-project-memory', relativePath: spec.rel },
    capturedAt: '2026-09-28T00:00:00.000Z',
    sensitivity: 'private',
  };
};

/** Seed a store with a previous manifest + its objects, then sync the registry. */
const seedPrevious = async (
  specs: Spec[],
): Promise<{ stackHome: string; registry: LocalRegistry }> => {
  const stackHome = await tempDir('stack-cont-');
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
    createdAt: '2026-09-28T00:00:00.000Z',
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
  const key =
    spec.project.kind === 'git'
      ? spec.project.canonical
      : `local:${spec.project.vendorKey}`;
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${key}/${spec.rel}`,
    project: spec.project,
    contentHash: hashBytes(Buffer.from(spec.body, 'utf8')),
    restoreTarget: { base: 'claude-project-memory', relativePath: spec.rel },
    source: { path: file },
    capturedAt: '2026-09-28T00:00:00.000Z',
    sensitivity: 'private',
  };
};

describe('backup continuity composition (15B.3)', () => {
  it('carries forward unresolved-project Memory and keeps available projects native', async () => {
    // Previous backup: Atlas (git, available), Stack (local, will be bound),
    // Nexus (local, unresolved), Other (local, unresolved).
    const stackDir = await tempDir('stack-proj-');
    const stackKey = encodeClaudeProjectKey(path.resolve(stackDir));
    const { stackHome, registry } = await seedPrevious([
      { project: git('github.com/acme/atlas'), rel: 'a1.md', body: 'a1' },
      { project: git('github.com/acme/atlas'), rel: 'a2.md', body: 'a2' },
      { project: local(stackKey), rel: 's1.md', body: 's1' },
      { project: local(stackKey), rel: 's2.md', body: 's2' },
      { project: local('C--legacy-nexus'), rel: 'n1.md', body: 'n1' },
      { project: local('C--legacy-nexus'), rel: 'n2.md', body: 'n2' },
      { project: local('C--legacy-nexus'), rel: 'n3.md', body: 'n3' },
      { project: local('C--legacy-nexus'), rel: 'n4.md', body: 'n4' },
      { project: local('C--legacy-other'), rel: 'o1.md', body: 'o1' },
      { project: local('C--legacy-other'), rel: 'o2.md', body: 'o2' },
    ]);

    // Bind Stack so it is available on this machine.
    const { resolveProjectForIdentity } = await import('./project/registry.js');
    const stackResolution = resolveProjectForIdentity(
      registry,
      local(stackKey),
    );
    const boundRegistry = setBinding(registry, {
      projectId:
        stackResolution.status === 'resolved' ? stackResolution.projectId : '',
      dir: stackDir,
      boundAt: '2026-09-28T00:00:00.000Z',
      provenance: 'user-map',
    });

    // Native scan on this machine: Atlas + Stack only (18-file analog).
    const atlasDir = await tempDir('atlas-');
    const nativeItems = [
      await nativeItem({
        project: git('github.com/acme/atlas'),
        rel: 'a1.md',
        body: 'a1',
      }),
      await nativeItem({
        project: git('github.com/acme/atlas'),
        rel: 'a2.md',
        body: 'a2',
      }),
      await nativeItem({ project: local(stackKey), rel: 's1.md', body: 's1' }),
      await nativeItem({ project: local(stackKey), rel: 's2.md', body: 's2' }),
    ];

    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry: boundRegistry,
      claudeHome: await tempDir('claude-'),
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });

    expect(composition.nativeFiles).toBe(4);
    expect(composition.nativeProjects).toBe(2);
    expect(composition.retainedFiles).toBe(6); // Nexus(4) + Other(2)
    expect(composition.retainedProjects).toBe(2);
    expect(composition.finalFiles).toBe(10);
    expect(composition.finalProjects).toBe(4);
    // The carried-forward set is exactly the unresolved projects' items.
    const carriedRels = composition.carriedForward
      .map((i) => i.logicalId.split('/').pop())
      .sort();
    expect(carriedRels).toEqual([
      'n1.md',
      'n2.md',
      'n3.md',
      'n4.md',
      'o1.md',
      'o2.md',
    ]);
  });

  it('runMemoryBackup keeps carried-forward bytes/hashes identical and writes the composed manifest', async () => {
    const { stackHome, registry } = await seedPrevious([
      { project: local('C--legacy-nexus'), rel: 'n1.md', body: 'NEXUS-ONE' },
    ]);
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry,
      claudeHome: await tempDir('claude-'),
      projects: [],
    });
    expect(composition.carriedForward).toHaveLength(1);
    const nexusHash = composition.carriedForward[0]?.contentHash as string;

    const native = await nativeItem({
      project: git('github.com/acme/atlas'),
      rel: 'a.md',
      body: 'ATLAS-NATIVE',
    });
    const result = await runMemoryBackup({
      stackHome,
      items: [native],
      carryForward: composition.carriedForward,
    });
    expect(result.files).toBe(2);

    const manifest = await readMemoryManifest(stackHome);
    const nexus = manifest?.items.find((i) => i.logicalId.endsWith('n1.md'));
    expect(nexus?.contentHash).toBe(nexusHash); // unchanged
    const { readMemoryObject } = await import('./store.js');
    const bytes = await readMemoryObject({ stackHome, contentHash: nexusHash });
    expect(Buffer.from(bytes).toString('utf8')).toBe('NEXUS-ONE');
  });

  it('native versions win where a safely resolved item changed', async () => {
    const atlasDir = await tempDir('atlas-');
    const { stackHome, registry } = await seedPrevious([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'OLD' },
    ]);
    const native = await nativeItem({
      project: git('github.com/acme/atlas'),
      rel: 'a.md',
      body: 'NEW',
    });
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [native],
      registry,
      claudeHome: await tempDir('claude-'),
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    // Atlas is available → not carried; the native (new) version is authoritative.
    expect(composition.carriedForward).toHaveLength(0);
    await runMemoryBackup({
      stackHome,
      items: [native],
      carryForward: composition.carriedForward,
    });
    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items[0]?.contentHash).toBe(
      hashBytes(Buffer.from('NEW', 'utf8')),
    );
  });

  it('fails closed (previous manifest intact) if a carried-forward object is missing', async () => {
    const { stackHome } = await seedPrevious([
      { project: local('C--legacy-keep'), rel: 'k.md', body: 'KEEP' },
    ]);
    const before = await readFile(
      (await import('./store.js')).memoryStorePaths(stackHome).currentManifest,
    );
    const native = await nativeItem({
      project: git('github.com/acme/atlas'),
      rel: 'a.md',
      body: 'A',
    });
    const bogus: ManifestItem = manifestItemOf({
      project: local('C--gone'),
      rel: 'x.md',
      body: 'never-stored',
    });
    await expect(
      runMemoryBackup({ stackHome, items: [native], carryForward: [bogus] }),
    ).rejects.toThrow();
    const after = await readFile(
      (await import('./store.js')).memoryStorePaths(stackHome).currentManifest,
    );
    expect(after.equals(before)).toBe(true); // previous backup unchanged
  });

  it('retains identity-conflict Memory without resolving it', async () => {
    const { stackHome } = await seedPrevious([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'a' },
    ]);
    // Force an identity conflict: two Project IDs claim the same Git identity.
    const conflicted: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
        {
          projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
      bindings: [],
    };
    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems: [],
      registry: conflicted,
      claudeHome: await tempDir('claude-'),
      projects: [
        {
          dir: await tempDir('atlas-'),
          gitRemote: 'https://github.com/acme/atlas',
        },
      ],
    });
    // The conflicted project's Memory is retained (not silently dropped/resolved).
    expect(composition.carriedForward).toHaveLength(1);
    expect(composition.retainedFiles).toBe(1);
  });
});

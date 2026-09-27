import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';
import {
  cloudRecover,
  encodeClaudeProjectKey,
  generateMmk,
  hashBytes,
  memoryStorePaths,
  protectedCloudBackup,
  readLocalRegistry,
  readPortableSnapshot,
  standardCloudBackup,
  syncRegistryForBackup,
  writeMemoryManifest,
  writeMemoryObject,
  runMemoryRestore,
  setBinding,
  writeLocalRegistry,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

import { stackCloudRemoteMemoryBackend } from './memory/cloud-backend.js';
import { mapProject } from './memory/project-ops.js';

const USER = '00000000-0000-4000-8000-00000000000a';

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

const makeCloud = () => {
  const memory = createInMemoryMemoryBackends();
  let counter = 0;
  const service = createCloudService({
    repository: createInMemoryRepository(),
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-secret',
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    memoryBackendFor: memory.memoryBackendFor,
  });
  const fetchImpl = createInProcessFetch(service);
  const anon = createCloudClient({
    baseUrl: 'http://localhost:3000',
    fetchImpl,
  });
  const signIn = async (userId: string): Promise<string> => {
    const start = await anon.authStart({});
    await service.approveCliAuth({
      userCode: start.userCode,
      profile: { userId, githubUsername: 'u' },
    });
    const token = await anon.authToken({ deviceSecret: start.deviceSecret });
    if (token.status !== 'approved') throw new Error('sign-in failed');
    return token.token;
  };
  const backendForToken = (token: string) =>
    stackCloudRemoteMemoryBackend(
      createCloudClient({ baseUrl: 'http://localhost:3000', token, fetchImpl }),
    );
  return { signIn, backendForToken };
};

const gitItem = (
  canonical: string,
  rel: string,
  body: string,
): ManifestItem => {
  const bytes = Buffer.from(body, 'utf8');
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${canonical}/${rel}`,
    project: {
      kind: 'git',
      canonical,
      host: canonical.split('/')[0] as string,
      owner: canonical.split('/')[1] as string,
      repo: canonical.split('/')[2] as string,
    },
    contentHash: hashBytes(bytes),
    restoreTarget: { base: 'claude-project-memory', relativePath: rel },
    capturedAt: '2026-09-27T00:00:00.000Z',
    sensitivity: 'private',
  };
};
const localItemFor = (
  vendorKey: string,
  rel: string,
  body: string,
): ManifestItem => {
  const bytes = Buffer.from(body, 'utf8');
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/local:${vendorKey}/${rel}`,
    project: { kind: 'local', vendorKey },
    contentHash: hashBytes(bytes),
    restoreTarget: { base: 'claude-project-memory', relativePath: rel },
    capturedAt: '2026-09-27T00:00:00.000Z',
    sensitivity: 'private',
  };
};

const writeStore = async (
  items: ManifestItem[],
  bodies: Map<string, string>,
) => {
  const stackHome = await tempDir('stack-A-');
  for (const item of items) {
    const body = bodies.get(item.logicalId) as string;
    await writeMemoryObject({
      stackHome,
      contentHash: item.contentHash,
      bytes: Buffer.from(body, 'utf8'),
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return stackHome;
};

const autoMemoryPath = (claudeHome: string, dir: string, rel: string) =>
  path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(path.resolve(dir)),
    'memory',
    rel,
  );

describe('Phase 15B project-identity acceptance (Machine F → map → new backup → Machine G)', () => {
  it('carries stable Project IDs through recovery, hardens path reuse, and never recreates source paths', async () => {
    const cloud = makeCloud();
    const backend = cloud.backendForToken(await cloud.signIn(USER));
    const mmk = generateMmk();

    // A reused path is a real directory that will exist on Machine F but held an
    // unrelated project there; the OLD Nexus Memory was keyed by that same path.
    const reusedNexusDir = await tempDir('Desktop-nexus-');
    const nexusVendorKey = encodeClaudeProjectKey(path.resolve(reusedNexusDir));
    const widgetVendorKey = 'C--Users-OLD-work-widget';

    // ---- OLD BACKUP (no portable registry): git Atlas + legacy Nexus + legacy widget.
    const bodies = new Map<string, string>();
    const atlas = gitItem('github.com/acme/atlas', 'a.md', 'ATLAS');
    const nexus = localItemFor(nexusVendorKey, 'n.md', 'NEXUS');
    const widget = localItemFor(widgetVendorKey, 'w.md', 'WIDGET');
    bodies.set(atlas.logicalId, 'ATLAS');
    bodies.set(nexus.logicalId, 'NEXUS');
    bodies.set(widget.logicalId, 'WIDGET');
    const machineA = await writeStore([atlas, nexus, widget], bodies);
    // Old-style bundle: no snapshot present in the store.
    expect(await readPortableSnapshot(machineA)).toBeNull();
    await protectedCloudBackup({ stackHome: machineA, backend, mmk });

    // ---- MACHINE F: fresh recover (lazy-mints Project IDs for all three).
    const machineF = await tempDir('stack-F-');
    await cloudRecover({ stackHome: machineF, backend, mmk });
    const regF0 = await readLocalRegistry(machineF);
    expect(regF0.projects).toHaveLength(3);
    expect(regF0.bindings).toEqual([]); // recovery never invents bindings

    // Candidate dirs on F: Atlas at a NEW path (git), unrelated project at the reused
    // Nexus path, and a fresh directory for the widget project.
    const atlasDirF = await tempDir('atlas-F-');
    const widgetDirF = await tempDir('widget-F-');
    const claudeF = await tempDir('claude-F-');

    const restore1 = await runMemoryRestore({
      stackHome: machineF,
      claudeHome: claudeF,
      apply: true,
      registry: regF0,
      projects: [
        { dir: atlasDirF, gitRemote: 'https://github.com/acme/atlas.git' },
        { dir: reusedNexusDir }, // path reuse — must NOT resolve Nexus
      ],
    });
    const statusByFile = Object.fromEntries(
      restore1.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(statusByFile['a.md']).toBe('restored'); // git-backed restorable
    expect(statusByFile['n.md']).toBe('project-not-found'); // path reuse blocked
    expect(statusByFile['w.md']).toBe('project-not-found'); // no binding yet
    // The reused directory received NO Nexus Memory.
    await expect(
      readFile(autoMemoryPath(claudeF, reusedNexusDir, 'n.md'), 'utf8'),
    ).rejects.toThrow();

    // ---- MAP the widget project explicitly to its real new directory on F.
    // Resolve widget's Project ID via its identity through the registry.
    const { resolveProjectForIdentity } = await import('@stack/memory');
    const widgetResolution = resolveProjectForIdentity(regF0, {
      kind: 'local',
      vendorKey: widgetVendorKey,
    });
    expect(widgetResolution.status).toBe('resolved');
    const widgetProjectId =
      widgetResolution.status === 'resolved' ? widgetResolution.projectId : '';

    const mapped = await mapProject({
      stackHome: machineF,
      selector: widgetProjectId,
      dir: widgetDirF,
      gitOrigin: async () => undefined,
    });
    expect(mapped.status).toBe('mapped');

    const regFMapped = await readLocalRegistry(machineF);
    const restore2 = await runMemoryRestore({
      stackHome: machineF,
      claudeHome: claudeF,
      apply: true,
      registry: regFMapped,
      projects: [
        { dir: atlasDirF, gitRemote: 'https://github.com/acme/atlas.git' },
        { dir: reusedNexusDir },
      ],
    });
    const status2 = Object.fromEntries(
      restore2.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(status2['w.md']).toBe('restored'); // now authorized by the binding
    expect(status2['n.md']).toBe('project-not-found'); // Nexus still unresolved
    expect(
      await readFile(autoMemoryPath(claudeF, widgetDirF, 'w.md'), 'utf8'),
    ).toBe('WIDGET');

    // ---- NEW BACKUP on F: now carries a portable registry snapshot (no paths).
    await syncRegistryForBackup({ stackHome: machineF });
    const snapF = await readPortableSnapshot(machineF);
    expect(snapF?.projects).toHaveLength(3);
    expect(JSON.stringify(snapF)).not.toContain('widget-F'); // no binding/path
    const newBackup = await protectedCloudBackup({
      stackHome: machineF,
      backend,
      mmk,
    });

    // Protected: the server payload is ciphertext — Project IDs are NOT in the clear.
    const payload = await backend.getPayload(newBackup.backupId);
    const payloadText = Buffer.from(payload).toString('utf8');
    expect(payloadText).not.toContain('snapshotVersion');
    for (const record of snapF?.projects ?? [])
      expect(payloadText).not.toContain(record.projectId);

    // ---- MACHINE G: fresh recover of the NEW backup.
    const machineG = await tempDir('stack-G-');
    await cloudRecover({ stackHome: machineG, backend, mmk });
    const regG = await readLocalRegistry(machineG);
    // Same Project IDs survive; NO bindings recreated (no source paths on G).
    expect(regG.projects.map((r) => r.projectId).sort()).toEqual(
      (snapF?.projects ?? []).map((r) => r.projectId).sort(),
    );
    expect(regG.bindings).toEqual([]);

    // On G, Atlas auto-resolves by strong Git identity; the mapped widget has its
    // Project ID but NO binding here, so it stays unresolved (no path recreation).
    const atlasDirG = await tempDir('atlas-G-');
    const claudeG = await tempDir('claude-G-');
    const restoreG = await runMemoryRestore({
      stackHome: machineG,
      claudeHome: claudeG,
      apply: true,
      registry: regG,
      projects: [
        { dir: atlasDirG, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    const statusG = Object.fromEntries(
      restoreG.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(statusG['a.md']).toBe('restored');
    expect(statusG['w.md']).toBe('project-not-found');
    expect(statusG['n.md']).toBe('project-not-found');

    // Current-machine bindings are not overwritten by a later recovered snapshot.
    let regGBound = await readLocalRegistry(machineG);
    const someId = regGBound.projects[0]?.projectId as string;
    const boundDir = await tempDir('g-bound-');
    regGBound = setBinding(regGBound, {
      projectId: someId,
      dir: boundDir,
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(machineG, regGBound);
    await cloudRecover({ stackHome: machineG, backend, mmk });
    const regGAfter = await readLocalRegistry(machineG);
    expect(regGAfter.bindings.some((b) => b.projectId === someId)).toBe(true);
  });

  it('Standard: the registry survives a round-trip with Standard (server-readable) semantics', async () => {
    const cloud = makeCloud();
    const backend = cloud.backendForToken(await cloud.signIn(USER));

    const bodies = new Map<string, string>();
    const atlas = gitItem('github.com/acme/atlas', 'a.md', 'ATLAS');
    bodies.set(atlas.logicalId, 'ATLAS');
    const machineA = await writeStore([atlas], bodies);
    await syncRegistryForBackup({ stackHome: machineA });
    const snapA = await readPortableSnapshot(machineA);
    await standardCloudBackup({ stackHome: machineA, backend });

    // Standard payload is the plaintext bundle: it carries the registry (server-readable).
    const latest = await backend.getLatest();
    const payload = await backend.getPayload(latest?.backupId as string);
    expect(Buffer.from(payload).toString('utf8')).toContain('registryB64');

    const dest = await tempDir('stack-std-dst-');
    await cloudRecover({ stackHome: dest, backend });
    const snapDest = await readPortableSnapshot(dest);
    expect(snapDest?.projects.map((r) => r.projectId)).toEqual(
      snapA?.projects.map((r) => r.projectId),
    );
  });

  it('public-stack boundary: the machine-local registry lives only under the memory store, never in the environment', async () => {
    const bodies = new Map<string, string>();
    const atlas = gitItem('github.com/acme/atlas', 'a.md', 'ATLAS');
    bodies.set(atlas.logicalId, 'ATLAS');
    const home = await writeStore([atlas], bodies);
    let reg = (await syncRegistryForBackup({ stackHome: home })).registry;
    reg = setBinding(reg, {
      projectId: reg.projects[0]?.projectId as string,
      dir: 'C:\\work\\atlas',
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(home, reg);

    const paths = memoryStorePaths(home);
    const memoryRoot = path.resolve(paths.root);
    // Both registry artifacts are confined to the private memory store subtree,
    // which is a separate artifact from anything `stack publish` serializes.
    for (const p of [
      paths.localProjectRegistry,
      paths.projectRegistrySnapshot,
    ]) {
      const rel = path.relative(memoryRoot, path.resolve(p));
      expect(rel.startsWith('..')).toBe(false);
    }
    // The binding/path only ever lives in the machine-local file, never the portable snapshot.
    const snap = await readFile(paths.projectRegistrySnapshot, 'utf8');
    expect(snap).not.toContain('C:\\\\work');
    expect(snap).not.toContain('bindings');
    const local = await readFile(paths.localProjectRegistry, 'utf8');
    expect(local).toContain('bindings');
  });
});

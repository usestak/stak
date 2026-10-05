import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  planMemoryBackupComposition,
  planMemoryRestore,
  protectedCloudBackup,
  readLocalRegistry,
  readPortableSnapshot,
  registryConflicts,
  resolveProjectForIdentity,
  runMemoryBackup,
  standardCloudBackup,
  syncRegistryForBackup,
  writeMemoryManifest,
  writeMemoryObject,
  runMemoryRestore,
  setBinding,
  writeLocalRegistry,
  type DiscoveredMemoryItem,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

import { stackCloudRemoteMemoryBackend } from './memory/cloud-backend.js';
import { mapProject } from './memory/project-ops.js';

const USER = '00000000-0000-4000-8000-00000000000a';

// A long, unique Memory-body marker for confidentiality checks. Unlike a 2-char body, it has
// negligible probability of occurring by chance in arbitrary AEAD ciphertext, so an assertion
// that it is absent from the server payload/metadata is deterministic, not probabilistic.
const NEXUS_SECRET = 'NEXUS-MEMORY-BODY-DO-NOT-LEAK-7b3f1a2c';

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

  it('two machines that independently migrate the same pre-registry bundle surface a conflict, not a silent merge', async () => {
    const cloud = makeCloud();
    const backend = cloud.backendForToken(await cloud.signIn(USER));
    const mmk = generateMmk();

    // OLD pre-registry bundle: one legacy local project, no portable snapshot.
    const bodies = new Map<string, string>();
    const nexus = localItemFor('C--Users-OLD-Desktop-nexus', 'n.md', 'NEXUS');
    bodies.set(nexus.logicalId, 'NEXUS');
    const machineA0 = await writeStore([nexus], bodies);
    expect(await readPortableSnapshot(machineA0)).toBeNull();
    await protectedCloudBackup({ stackHome: machineA0, backend, mmk });

    // Machine A and Machine B independently recover it → different opaque IDs.
    const machineA = await tempDir('stack-A2-');
    const machineB = await tempDir('stack-B2-');
    await cloudRecover({ stackHome: machineA, backend, mmk });
    await cloudRecover({ stackHome: machineB, backend, mmk });
    const idA = (await readLocalRegistry(machineA)).projects[0]?.projectId;
    const idB = (await readLocalRegistry(machineB)).projects[0]?.projectId;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB); // acceptable first-window divergence

    // B explicitly binds its migrated project locally.
    const bDir = await tempDir('nexus-B-');
    let regB = await readLocalRegistry(machineB);
    regB = setBinding(regB, {
      projectId: idB as string,
      dir: bDir,
      boundAt: '2026-09-28T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(machineB, regB);

    // A now makes a registry-bearing backup; B recovers it → registries meet.
    await syncRegistryForBackup({ stackHome: machineA });
    await protectedCloudBackup({ stackHome: machineA, backend, mmk });
    await cloudRecover({ stackHome: machineB, backend, mmk });

    const regBMerged = await readLocalRegistry(machineB);
    // Deterministic conflict, both records preserved, no silent last-write-wins.
    expect(registryConflicts(regBMerged).length).toBeGreaterThan(0);
    expect(regBMerged.projects.map((r) => r.projectId).sort()).toEqual(
      [idA as string, idB as string].sort(),
    );
    // The machine-local binding is untouched by the recovered state.
    expect(regBMerged.bindings.some((b) => b.projectId === idB)).toBe(true);

    // Restore withholds the ambiguous project (no silent contamination), memory kept.
    const claudeB = await tempDir('claude-B2-');
    const restoreB = await runMemoryRestore({
      stackHome: machineB,
      claudeHome: claudeB,
      apply: true,
      registry: regBMerged,
      projects: [],
    });
    expect(restoreB.items[0]?.status).toBe('identity-conflict');
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

  it('15B.3 continuity: unresolved Memory survives backup and a fresh recovery; dry-run is non-mutating', async () => {
    const cloud = makeCloud();
    const backend = cloud.backendForToken(await cloud.signIn(USER));
    const mmk = generateMmk();

    // OLD pre-registry bundle: Atlas (git, 2) + Stack (local, 2) + Nexus (local, 4)
    // + Other (local, 2) = 10 files / 4 projects, no portable registry snapshot.
    const stackKey = 'C--Users-OLD-Desktop-stack';
    const bodies = new Map<string, string>();
    const items: ManifestItem[] = [];
    const add = (item: ManifestItem, body: string) => {
      bodies.set(item.logicalId, body);
      items.push(item);
    };
    add(gitItem('github.com/acme/atlas', 'a1.md', 'A1'), 'A1');
    add(gitItem('github.com/acme/atlas', 'a2.md', 'A2'), 'A2');
    add(localItemFor(stackKey, 's1.md', 'S1'), 'S1');
    add(localItemFor(stackKey, 's2.md', 'S2'), 'S2');
    // Nexus bodies carry the long unique marker so the Protected confidentiality check below
    // is deterministic. These are carried forward (unresolved) into the new backup.
    for (let i = 1; i <= 4; i += 1) {
      const body = `N${i} ${NEXUS_SECRET}`;
      add(localItemFor('C--legacy-nexus', `n${i}.md`, body), body);
    }
    add(localItemFor('C--legacy-other', 'o1.md', 'O1'), 'O1');
    add(localItemFor('C--legacy-other', 'o2.md', 'O2'), 'O2');
    const machineA = await writeStoreItems(items, bodies);
    expect(await readPortableSnapshot(machineA)).toBeNull();
    await protectedCloudBackup({ stackHome: machineA, backend, mmk });

    // Machine F: recover the OLD bundle → 10 items / 4 lazily-minted projects.
    const machineF = await tempDir('stack-F3-');
    await cloudRecover({ stackHome: machineF, backend, mmk });
    const regF0 = await readLocalRegistry(machineF);
    expect(regF0.projects).toHaveLength(4);

    // Map the Stack-like legacy project to a real directory on F.
    const stackDir = await tempDir('stack-here-');
    const stackRes = resolveProjectForIdentity(regF0, {
      kind: 'local',
      vendorKey: stackKey,
    });
    await mapProject({
      stackHome: machineF,
      selector: stackRes.status === 'resolved' ? stackRes.projectId : '',
      dir: stackDir,
      gitOrigin: async () => undefined,
    });
    const regF = await readLocalRegistry(machineF);

    // The available projects' current native Memory (Atlas via Git, Stack via binding),
    // under their recovered identities.
    const atlasDir = await tempDir('atlas-F3-');
    const nativeItems: DiscoveredMemoryItem[] = [];
    for (const [canonicalOrKey, rel, body, kind] of [
      ['github.com/acme/atlas', 'a1.md', 'A1', 'git'],
      ['github.com/acme/atlas', 'a2.md', 'A2', 'git'],
      [stackKey, 's1.md', 'S1', 'local'],
      [stackKey, 's2.md', 'S2', 'local'],
    ] as const)
      nativeItems.push(await makeNative(canonicalOrKey, rel, body, kind));

    // Dry-run preview must be non-mutating and idempotent.
    const beforeStore = await readFile(
      memoryStorePaths(machineF).currentManifest,
    );
    const beforeRegistry = await readFile(
      memoryStorePaths(machineF).localProjectRegistry,
    );
    const preview = await planMemoryBackupComposition({
      stackHome: machineF,
      nativeItems,
      registry: regF,
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    const preview2 = await planMemoryBackupComposition({
      stackHome: machineF,
      nativeItems,
      registry: regF,
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    expect(preview.nativeFiles).toBe(4);
    expect(preview.retainedFiles).toBe(6); // Nexus(4) + Other(2)
    expect(preview.finalFiles).toBe(10);
    expect(preview.finalProjects).toBe(4);
    expect(preview2).toEqual(preview); // idempotent
    // No store or registry file changed by previewing.
    expect(
      (await readFile(memoryStorePaths(machineF).currentManifest)).equals(
        beforeStore,
      ),
    ).toBe(true);
    expect(
      (await readFile(memoryStorePaths(machineF).localProjectRegistry)).equals(
        beforeRegistry,
      ),
    ).toBe(true);

    // Real backup: compose, commit, and push a NEW registry-bearing generation.
    await runMemoryBackup({
      stackHome: machineF,
      items: nativeItems,
      carryForward: preview.carriedForward,
    });
    await syncRegistryForBackup({ stackHome: machineF });
    const composed = await readPortableSnapshot(machineF);
    expect(composed?.projects).toHaveLength(4); // all 4 project IDs represented
    const newBackup = await protectedCloudBackup({
      stackHome: machineF,
      backend,
      mmk,
    });

    // Protected: ciphertext exposes no registry/Memory plaintext.
    const payload = await backend.getPayload(newBackup.backupId);
    const payloadText = Buffer.from(payload).toString('utf8');
    expect(payloadText).not.toContain('snapshotVersion');
    // The Nexus Memory body is carried forward into this Protected backup. Its plaintext must
    // not appear in the opaque AEAD payload — searched at the BYTE level, not by decoding
    // arbitrary ciphertext as UTF-8 — nor in the server-visible generation metadata, which is
    // the only server-readable plaintext. The former `not.toContain('N1')` was invalid: a
    // 2-char body can occur in random ciphertext by chance, so it flaked ~1 run in 6.
    const protectedMeta = await backend.getGenerationById(newBackup.backupId);
    expect(protectedMeta?.privacyMode).toBe('protected');
    expect(
      Buffer.from(payload).includes(Buffer.from(NEXUS_SECRET, 'utf8')),
    ).toBe(false);
    expect(JSON.stringify(protectedMeta ?? {})).not.toContain(NEXUS_SECRET);
    expect(payloadText).not.toContain(stackKey);

    // Machine G: fresh recovery receives ALL 10 items (unresolved Memory survived).
    const machineG = await tempDir('stack-G3-');
    await cloudRecover({ stackHome: machineG, backend, mmk });
    const manifestG = memoryStorePaths(machineG).currentManifest;
    const parsedG = JSON.parse(await readFile(manifestG, 'utf8')) as {
      items: ManifestItem[];
    };
    expect(parsedG.items).toHaveLength(10);
    const regG = await readLocalRegistry(machineG);
    expect(regG.projects.map((r) => r.projectId).sort()).toEqual(
      (composed?.projects ?? []).map((r) => r.projectId).sort(),
    );
    expect(regG.bindings).toEqual([]); // no Machine F filesystem bindings

    // Resolution on G: Atlas auto-resolves by Git; the rest stay unavailable.
    const atlasDirG = await tempDir('atlas-G3-');
    const planG = await planMemoryRestore({
      stackHome: machineG,
      claudeHome: await tempDir('claude-G3-'),
      registry: regG,
      projects: [
        { dir: atlasDirG, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    const statusByRel = new Map(
      planG.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(statusByRel.get('a1.md')).toBe('restorable'); // Git resolves
    expect(statusByRel.get('s1.md')).toBe('project-not-found'); // mapped-only, unbound on G
    expect(statusByRel.get('n1.md')).toBe('project-not-found'); // Nexus unresolved
    expect(statusByRel.get('o1.md')).toBe('project-not-found');
  });

  it('15B.3 continuity holds under Standard privacy too', async () => {
    const cloud = makeCloud();
    const backend = cloud.backendForToken(await cloud.signIn(USER));

    const bodies = new Map<string, string>();
    const items: ManifestItem[] = [];
    const add = (item: ManifestItem, body: string) => {
      bodies.set(item.logicalId, body);
      items.push(item);
    };
    add(gitItem('github.com/acme/atlas', 'a.md', 'A'), 'A');
    add(localItemFor('C--legacy-nexus', 'n1.md', 'N1'), 'N1');
    add(localItemFor('C--legacy-nexus', 'n2.md', 'N2'), 'N2');
    const machineA = await writeStoreItems(items, bodies);
    await standardCloudBackup({ stackHome: machineA, backend });

    const machineF = await tempDir('stack-Fs-');
    await cloudRecover({ stackHome: machineF, backend });
    const regF = await readLocalRegistry(machineF);
    // Native scan finds only Atlas; Nexus is unresolved and must be carried forward.
    const native = [
      await makeNative('github.com/acme/atlas', 'a.md', 'A', 'git'),
    ];
    const preview = await planMemoryBackupComposition({
      stackHome: machineF,
      nativeItems: native,
      registry: regF,
      projects: [
        {
          dir: await tempDir('atlas-Fs-'),
          gitRemote: 'https://github.com/acme/atlas.git',
        },
      ],
    });
    expect(preview.retainedFiles).toBe(2); // Nexus
    await runMemoryBackup({
      stackHome: machineF,
      items: native,
      carryForward: preview.carriedForward,
    });
    await syncRegistryForBackup({ stackHome: machineF });
    await standardCloudBackup({ stackHome: machineF, backend });

    const machineG = await tempDir('stack-Gs-');
    await cloudRecover({ stackHome: machineG, backend });
    const parsedG = JSON.parse(
      await readFile(memoryStorePaths(machineG).currentManifest, 'utf8'),
    ) as { items: ManifestItem[] };
    expect(parsedG.items).toHaveLength(3); // Atlas + Nexus(2) survived
  });
});

/** Write a store from explicit manifest items + bodies (objects included). */
const writeStoreItems = async (
  items: ManifestItem[],
  bodies: Map<string, string>,
): Promise<string> => {
  const stackHome = await mkdtemp(path.join(tmpdir(), 'stack-Aitems-'));
  roots.push(stackHome);
  for (const item of items) {
    const body = bodies.get(item.logicalId) as string;
    await writeMemoryObject({
      stackHome,
      contentHash: item.contentHash,
      bytes: Buffer.from(body, 'utf8'),
    });
  }
  await writeMemoryManifest({
    stackHome,
    manifest: {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-09-28T00:00:00.000Z',
      items,
    },
  });
  return stackHome;
};

/** A native (freshly discovered) item backed by a real temp file. */
const makeNative = async (
  canonicalOrKey: string,
  rel: string,
  body: string,
  kind: 'git' | 'local',
): Promise<DiscoveredMemoryItem> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native3-'));
  roots.push(dir);
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
  const project: ManifestItem['project'] =
    kind === 'git'
      ? {
          kind: 'git',
          canonical: canonicalOrKey,
          host: canonicalOrKey.split('/')[0] as string,
          owner: canonicalOrKey.split('/')[1] as string,
          repo: canonicalOrKey.split('/')[2] as string,
        }
      : { kind: 'local', vendorKey: canonicalOrKey };
  const key = kind === 'git' ? canonicalOrKey : `local:${canonicalOrKey}`;
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${key}/${rel}`,
    project,
    contentHash: hashBytes(Buffer.from(body, 'utf8')),
    restoreTarget: { base: 'claude-project-memory', relativePath: rel },
    source: { path: file },
    capturedAt: '2026-09-28T00:00:00.000Z',
    sensitivity: 'private',
  };
};

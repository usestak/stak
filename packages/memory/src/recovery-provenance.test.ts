import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ManifestItem,
  MemoryManifest,
  ProjectIdentity,
} from './domain.js';
import {
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
} from './remote/backend.js';
import {
  cloudRecover,
  protectedCloudBackup,
  standardCloudBackup,
} from './remote/modes.js';
import { generateMmk } from './remote/mmk.js';
import {
  setBinding,
  toPortableSnapshot,
  type LocalRegistry,
  type PortableProjectRecord,
} from './project/registry.js';
import {
  readLocalRegistry,
  readPortableSnapshot,
  writeLocalRegistry,
  writePortableSnapshot,
} from './project/registry-store.js';
import {
  hashBytes,
  memoryStorePaths,
  writeMemoryManifest,
  writeMemoryObject,
} from './store.js';

/**
 * Phase 15B.5 — recovery registry PROVENANCE. Proves the ONLY source of a recovered
 * machine's portable project registry is the committed Cloud generation's own payload
 * (`registryB64`), that committed payloads are immutable, and that no other machine's
 * local state can leak in. This is the mechanism by which fresh Machine F2 reproduced
 * the exact contaminated Project IDs from a committed generation.
 */
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

const A = '0123456789abcdefghjkmnpqrstvwxyz';
const pid = (n: number) => `prj_${(A[n] as string).repeat(26)}`;

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

/** Write a store (objects + manifest). Optionally attach a portable snapshot. */
const buildStore = async (
  specs: Spec[],
  snapshotFrom?: LocalRegistry,
): Promise<string> => {
  const stackHome = await tempDir('stack-prov-');
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

const makeBackend = (userId = 'user-prov') =>
  inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), userId);

const readManifest = async (stackHome: string) =>
  JSON.parse(
    await readFile(memoryStorePaths(stackHome).currentManifest, 'utf8'),
  ) as MemoryManifest;

describe('committed generation immutability (15B.5)', () => {
  it('rejects a duplicate backupId and never overwrites a prior generation payload', async () => {
    const backend = makeBackend();
    const p0 = Buffer.from('payload-zero', 'utf8');
    const p1 = Buffer.from('payload-one', 'utf8');
    const g0 = await backend.createGeneration({
      backupId: 'b0',
      expectedParent: null,
      privacyMode: 'standard',
      payload: p0,
      bundleFormatVersion: 'stack-mem-bundle-v1',
    });
    // Duplicate backupId is refused (payload immutable, no silent overwrite).
    await expect(
      backend.createGeneration({
        backupId: 'b0',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('tampered', 'utf8'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      }),
    ).rejects.toThrow();
    // A later generation does not alter the earlier generation's payload bytes.
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: 0,
      privacyMode: 'standard',
      payload: p1,
      bundleFormatVersion: 'stack-mem-bundle-v1',
    });
    expect(Buffer.from(await backend.getPayload('b0')).equals(p0)).toBe(true);
    expect(Buffer.from(await backend.getPayload('b1')).equals(p1)).toBe(true);
    expect(g0.generation).toBe(0);
  });
});

describe('recovery registry provenance (15B.5)', () => {
  it('a registry-bearing generation reproduces its EXACT Project IDs on a fresh machine (the F2 mechanism)', async () => {
    // Source registry with fixed, known IDs; snapshot rides in the committed bundle.
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: pid(1),
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
        {
          projectId: pid(2),
          claims: [{ type: 'legacy-compat', key: 'compat:deadbeef' }],
        },
      ],
      bindings: [],
    };
    const source = await buildStore(
      [
        { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
        { project: local('C--old-nexus'), rel: 'n.md', body: 'N' },
      ],
      registry,
    );
    const backend = makeBackend();
    await standardCloudBackup({ stackHome: source, backend });

    const fresh = await tempDir('stack-fresh-');
    await cloudRecover({ stackHome: fresh, backend });
    const snap = await readPortableSnapshot(fresh);
    expect(snap?.projects.map((r) => r.projectId).sort()).toEqual(
      [pid(1), pid(2)].sort(),
    );
  });

  it('a genuinely pre-registry generation carries NO registry; two fresh recoveries mint DIFFERENT random IDs', async () => {
    // No snapshot attached → the committed bundle has no registryB64.
    const source = await buildStore([
      { project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
      { project: local('C--old-nexus'), rel: 'n.md', body: 'N' },
    ]);
    const backend = makeBackend();
    await standardCloudBackup({ stackHome: source, backend });

    const b1 = await tempDir('stack-b1-');
    const b2 = await tempDir('stack-b2-');
    await cloudRecover({ stackHome: b1, backend });
    await cloudRecover({ stackHome: b2, backend });
    const r1 = await readLocalRegistry(b1);
    const r2 = await readLocalRegistry(b2);
    // Same logical project COUNT (2), but independently random IDs → they differ.
    expect(r1.projects).toHaveLength(2);
    expect(r2.projects).toHaveLength(2);
    const ids1 = new Set(r1.projects.map((p) => p.projectId));
    const ids2 = r2.projects.map((p) => p.projectId);
    expect(ids2.some((id) => ids1.has(id))).toBe(false);
  });

  it('a fresh recovery uses ONLY the committed Cloud payload — another machine’s contaminated local registry is irrelevant', async () => {
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: pid(3),
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
      bindings: [],
    };
    const machineA = await buildStore(
      [{ project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' }],
      registry,
    );
    const backend = makeBackend();
    await standardCloudBackup({ stackHome: machineA, backend });

    // Machine A's LOCAL registry is then contaminated (never re-backed-up).
    const contaminated = setBinding(
      {
        ...registry,
        projects: [
          ...registry.projects,
          {
            projectId: pid(9),
            claims: [{ type: 'legacy-compat', key: 'compat:bogus' }],
          },
        ],
      },
      {
        projectId: pid(3),
        dir: 'C:\\a',
        boundAt: '2026-09-29T00:00:00.000Z',
        provenance: 'user-map',
      },
    );
    await writeLocalRegistry(machineA, contaminated);

    // Machine B recovers fresh: it must see ONLY the committed Cloud state (1 project,
    // no binding, no bogus record).
    const machineB = await tempDir('stack-B-');
    await cloudRecover({ stackHome: machineB, backend });
    const rb = await readLocalRegistry(machineB);
    expect(rb.projects.map((p) => p.projectId)).toEqual([pid(3)]);
    expect(rb.bindings).toEqual([]);
  });

  it('faithfully reproduces the F2-shaped 10-registry / 9-manifest contamination from a committed bundle, without merging', async () => {
    // Manifest: 7 local-Atlas files + 8 legacy projects (20 files) = 27 files / 9 identities.
    const specs: Spec[] = [];
    for (let i = 1; i <= 7; i += 1)
      specs.push({
        project: local('C--machine-f-atlas'),
        rel: `a${i}.md`,
        body: `A${i}`,
      });
    const counts = [4, 4, 3, 3, 2, 2, 1, 1]; // 8 legacy projects, 20 files
    counts.forEach((count, p) => {
      for (let f = 1; f <= count; f += 1)
        specs.push({
          project: local(`C--legacy-${p}`),
          rel: `f${f}.md`,
          body: `L${p}-${f}`,
        });
    });

    // Registry has TEN records: a stale git-Atlas + the local-Atlas duplicate + 8 legacy.
    const registryProjects: PortableProjectRecord[] = [
      {
        projectId: pid(0),
        claims: [
          {
            type: 'git',
            canonical: 'github.com/reymiahthesun-bit/atlas-access-flow',
          },
        ],
      },
      {
        projectId: pid(1),
        claims: [{ type: 'legacy-compat', key: 'compat:atlaslocal' }],
      },
    ];
    for (let p = 0; p < 8; p += 1)
      registryProjects.push({
        projectId: pid(p + 2),
        claims: [{ type: 'legacy-compat', key: `compat:legacy-${p}` }],
      });
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: registryProjects,
      bindings: [],
    };
    const source = await buildStore(specs, registry);
    const backend = makeBackend();
    await standardCloudBackup({ stackHome: source, backend });

    const fresh = await tempDir('stack-f2shape-');
    await cloudRecover({ stackHome: fresh, backend });

    // The portable registry snapshot faithfully carries all TEN records...
    const snap = await readPortableSnapshot(fresh);
    expect(snap?.projects).toHaveLength(10);
    // ...including both the Git-Atlas record and the duplicate local-Atlas record.
    expect(snap?.projects.map((r) => r.projectId)).toContain(pid(0));
    expect(snap?.projects.map((r) => r.projectId)).toContain(pid(1));
    // ...while the manifest references only NINE distinct project identities / 27 files.
    const manifest = await readManifest(fresh);
    expect(manifest.items).toHaveLength(27);
    const identityKeys = new Set(
      manifest.items.map((i) => (i.project ? idKey(i.project) : '(none)')),
    );
    expect(identityKeys.size).toBe(9);
    // No merge, no bindings invented on the fresh machine.
    expect((await readLocalRegistry(fresh)).bindings).toEqual([]);
  });

  it('Protected recovery follows the same registry provenance as Standard', async () => {
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: pid(5),
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
      bindings: [],
    };
    const source = await buildStore(
      [{ project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' }],
      registry,
    );
    const backend = makeBackend();
    const mmk = generateMmk();
    await protectedCloudBackup({ stackHome: source, backend, mmk });

    // The server-facing ciphertext must not expose the registry in plaintext.
    const latest = await backend.getLatest();
    const payload = await backend.getPayload(latest?.backupId as string);
    expect(Buffer.from(payload).toString('utf8')).not.toContain(pid(5));

    const fresh = await tempDir('stack-prot-');
    await cloudRecover({ stackHome: fresh, backend, mmk });
    const snap = await readPortableSnapshot(fresh);
    expect(snap?.projects.map((r) => r.projectId)).toEqual([pid(5)]);
  });

  it('a second user cannot read the first user’s committed payload (per-user isolation)', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const a = inMemoryRemoteMemoryBackend(store, 'user-a');
    const b = inMemoryRemoteMemoryBackend(store, 'user-b');
    const source = await buildStore(
      [{ project: git('github.com/acme/atlas'), rel: 'a.md', body: 'A' }],
      {
        schemaVersion: 1,
        projects: [
          {
            projectId: pid(7),
            claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
          },
        ],
        bindings: [],
      },
    );
    await standardCloudBackup({ stackHome: source, backend: a });
    expect(await b.getLatest()).toBeNull();
    const fresh = await tempDir('stack-userb-');
    await expect(
      cloudRecover({ stackHome: fresh, backend: b }),
    ).rejects.toThrow();
  });
});

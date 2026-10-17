import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '../domain.js';
import { writeMemoryManifest } from '../store.js';
import {
  nameHintFor,
  resolveProjectForIdentity,
  setBinding,
  setExplicitNameHint,
} from './registry.js';
import {
  readLocalRegistry,
  readPortableSnapshot,
  reconcileRegistryAfterRecover,
  syncRegistryForBackup,
  writeLocalRegistry,
} from './registry-store.js';

const roots: string[] = [];
const tempHome = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-reg-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const gitItem = (canonical: string, rel: string): ManifestItem => ({
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
  contentHash: `sha256:${'0'.repeat(64)}`,
  restoreTarget: { base: 'claude-project-memory', relativePath: rel },
  capturedAt: '2026-09-27T00:00:00.000Z',
  sensitivity: 'private',
});
const localItem = (vendorKey: string, rel: string): ManifestItem => ({
  provider: 'claude',
  kind: 'auto-memory',
  scope: 'project',
  logicalId: `claude/auto-memory/local:${vendorKey}/${rel}`,
  project: { kind: 'local', vendorKey },
  contentHash: `sha256:${'1'.repeat(64)}`,
  restoreTarget: { base: 'claude-project-memory', relativePath: rel },
  capturedAt: '2026-09-27T00:00:00.000Z',
  sensitivity: 'private',
});
const writeManifest = async (stackHome: string, items: ManifestItem[]) => {
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
};

let counter = 0;
const mint = () => `prj_${(counter++).toString(36).padStart(26, '0')}`;

describe('registry store', () => {
  it('round-trips the machine-local registry', async () => {
    const home = await tempHome();
    counter = 0;
    let reg = await readLocalRegistry(home);
    expect(reg.projects).toEqual([]);
    reg = setBinding(reg, {
      projectId: mint(),
      dir: 'C:\\work\\atlas',
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(home, reg);
    const read = await readLocalRegistry(home);
    expect(read).toEqual(reg);
  });

  it('backup sync mints Project IDs and writes a snapshot WITHOUT bindings/paths', async () => {
    const home = await tempHome();
    counter = 0;
    await writeManifest(home, [
      gitItem('github.com/acme/atlas', 'a.md'),
      localItem('C--Users-NT-Desktop-nexus', 'n.md'),
    ]);
    const { minted } = await syncRegistryForBackup({ stackHome: home, mint });
    expect(minted).toBe(2);

    const snapshot = await readPortableSnapshot(home);
    expect(snapshot?.projects).toHaveLength(2);
    const snapshotText = JSON.stringify(snapshot);
    expect(snapshotText).not.toContain('nexus');
    expect(snapshotText).not.toContain('bindings');

    // A machine-local binding never appears in the portable snapshot.
    let reg = await readLocalRegistry(home);
    const projectId = reg.projects[0]?.projectId as string;
    reg = setBinding(reg, {
      projectId,
      dir: 'C:\\work\\atlas',
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(home, reg);
    await syncRegistryForBackup({ stackHome: home, mint });
    const snap2 = await readPortableSnapshot(home);
    expect(JSON.stringify(snap2)).not.toContain('C:\\\\work');
    expect(JSON.stringify(snap2)).not.toContain('work');
  });

  it('recover reconcile lazily mints when the bundle carried no snapshot', async () => {
    const home = await tempHome();
    counter = 0;
    await writeManifest(home, [localItem('C--Users-X-old-nexus', 'n.md')]);
    const { registry } = await reconcileRegistryAfterRecover({
      stackHome: home,
      mint,
    });
    expect(registry.projects).toHaveLength(1);
    // No binding invented for a legacy project without a directory.
    expect(registry.bindings).toEqual([]);
  });
});

describe('syncRegistryForBackup name hints', () => {
  it('persists a discovery-time name hint for a local project, keyed by its resolved Project ID', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const { registry } = await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const record = registry.projects[0];
    if (!record) throw new Error('expected a minted project record');
    expect(nameHintFor(registry, record.projectId)).toBe('nexus');

    // Persisted to disk, not just returned in-memory.
    const reloaded = await readLocalRegistry(stackHome);
    expect(nameHintFor(reloaded, record.projectId)).toBe('nexus');
  });

  it('does not add a hint for a vendor key the manifest does not reference', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const { registry } = await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-swft', 'swft']]), // unrelated vendor key
    });

    const record = registry.projects[0];
    if (!record) throw new Error('expected a minted project record');
    expect(nameHintFor(registry, record.projectId)).toBeUndefined();
  });

  it('never writes a name hint into the portable snapshot', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const snapshot = await readPortableSnapshot(stackHome);
    expect(JSON.stringify(snapshot)).not.toContain('nexus');
  });
});

describe('Local -> Git identity-strengthening retires the obsolete local record (Bug B, production regression)', () => {
  it('one logical Project survives — not local L + git G — for the exact stack-repo case', async () => {
    const stackHome = await tempHome();
    const vendorKey = 'C--Users-NT-Desktop-stack';

    // Earlier backup: this checkout's Git remote was not yet resolvable, so its
    // auto-memory resolved as a local-only identity and minted projectId L.
    await writeManifest(stackHome, [localItem(vendorKey, 'old.md')]);
    const first = await syncRegistryForBackup({ stackHome, mint });
    const localProjectId = first.registry.projects[0]?.projectId;
    expect(localProjectId).toBeDefined();

    // Later backup: the SAME directory's Git remote is now resolvable, so discovery
    // resolves it to the strong Git identity — but discovery still reports the SAME
    // vendor key backing it (via `source.vendorKey` / `onLocalProjectResolved`), which
    // is how the caller builds `vendorKeys`.
    await writeManifest(stackHome, [
      gitItem('github.com/usestak/stak', 'new.md'),
    ]);
    const second = await syncRegistryForBackup({
      stackHome,
      mint,
      vendorKeys: new Map([['github.com/usestak/stak', vendorKey]]),
    });

    // Exactly one active logical Project — the obsolete local record is gone.
    expect(second.registry.projects).toHaveLength(1);
    const survivor = second.registry.projects[0];
    expect(survivor?.projectId).not.toBe(localProjectId);
    expect(
      resolveProjectForIdentity(second.registry, {
        kind: 'git',
        canonical: 'github.com/usestak/stak',
        host: 'github.com',
        owner: 'usestak',
        repo: 'stak',
      }),
    ).toEqual({ status: 'resolved', projectId: survivor?.projectId });
    // The old local identity now also resolves to the SAME surviving Project (never a
    // dangling second id if something still reports it as local-only transiently).
    expect(
      resolveProjectForIdentity(second.registry, { kind: 'local', vendorKey }),
    ).toEqual({ status: 'resolved', projectId: survivor?.projectId });

    // Persisted to disk, not just returned in-memory.
    const reloaded = await readLocalRegistry(stackHome);
    expect(reloaded.projects).toHaveLength(1);
  });

  it('does nothing when no stale local record exists for the vendor key (first-ever Git resolution)', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [gitItem('github.com/acme/atlas', 'a.md')]);
    const result = await syncRegistryForBackup({
      stackHome,
      mint,
      vendorKeys: new Map([
        ['github.com/acme/atlas', 'C--Users-NT-Desktop-atlas'],
      ]),
    });
    expect(result.registry.projects).toHaveLength(1);
  });
});

describe('explicit display names survive future backups (stak project name precedence)', () => {
  it('a later backup whose discovery DOES find a basename never overwrites a previously-set explicit name', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const first = await syncRegistryForBackup({ stackHome, mint });
    const projectId = first.registry.projects[0]?.projectId as string;
    const explicit = setExplicitNameHint(first.registry, projectId, 'my nexus');
    await writeLocalRegistry(stackHome, explicit);

    // A later backup where discovery DOES resolve a directory again (e.g. the folder
    // reappeared under a different basename) must not clobber the explicit rename.
    const second = await syncRegistryForBackup({
      stackHome,
      mint,
      nameHints: new Map([
        ['C--Users-NT-Desktop-nexus', 'some-other-basename'],
      ]),
    });

    expect(nameHintFor(second.registry, projectId)).toBe('my nexus');

    const reloaded = await readLocalRegistry(stackHome);
    expect(nameHintFor(reloaded, projectId)).toBe('my nexus');
  });
});

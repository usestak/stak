import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '../domain.js';
import { writeMemoryManifest } from '../store.js';
import { setBinding } from './registry.js';
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

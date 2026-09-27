import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '@stack/memory';
import {
  readLocalRegistry,
  syncRegistryForBackup,
  writeMemoryManifest,
} from '@stack/memory';

import { listProjects, mapProject } from './project-ops.js';

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

const seedRegistry = async (items: ManifestItem[]): Promise<string> => {
  const stackHome = await tempDir('stack-pops-');
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  let counter = 0;
  await syncRegistryForBackup({
    stackHome,
    mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
  });
  return stackHome;
};

const noGit = async () => undefined;

describe('stack project ops', () => {
  it('lists projects with availability, files, and binding state', async () => {
    const stackHome = await seedRegistry([
      gitItem('github.com/acme/atlas', 'a.md'),
      localItem('C--Users-X-nexus', 'n.md'),
    ]);
    const rows = await listProjects({
      stackHome,
      projects: [
        {
          dir: '/somewhere/atlas',
          gitRemote: 'https://github.com/acme/atlas.git',
        },
      ],
    });
    const atlas = rows.find((r) => r.identity.kind === 'git');
    const nexus = rows.find((r) => r.identity.kind === 'local');
    expect(atlas?.availability).toBe('present'); // git auto-matches a candidate
    expect(atlas?.files).toBe(1);
    expect(nexus?.availability).toBe('unavailable'); // no binding, no git
    expect(nexus?.files).toBe(1);
  });

  it('maps a legacy project to a directory as a machine-local binding only', async () => {
    const stackHome = await seedRegistry([
      localItem('C--Users-X-nexus', 'n.md'),
    ]);
    const registry0 = await readLocalRegistry(stackHome);
    const projectId = registry0.projects[0]?.projectId as string;
    const dir = await tempDir('nexus-here-');

    const result = await mapProject({
      stackHome,
      selector: projectId,
      dir,
      gitOrigin: noGit,
    });
    expect(result).toMatchObject({ status: 'mapped', projectId });

    const registry = await readLocalRegistry(stackHome);
    expect(registry.bindings).toHaveLength(1);
    expect(registry.bindings[0]?.dir).toBe(path.resolve(dir));
    // The path is NOT promoted to a portable identity claim (no path in claims/snapshot).
    for (const record of registry.projects)
      expect(JSON.stringify(record.claims)).not.toContain('nexus-here');
  });

  it('rejects mapping to a directory whose git identity conflicts with the project', async () => {
    const stackHome = await seedRegistry([
      gitItem('github.com/acme/atlas', 'a.md'),
    ]);
    const registry0 = await readLocalRegistry(stackHome);
    const projectId = registry0.projects[0]?.projectId as string;
    const dir = await tempDir('other-repo-');

    const result = await mapProject({
      stackHome,
      selector: projectId,
      dir,
      gitOrigin: async () => 'https://github.com/other/thing.git',
    });
    expect(result.status).toBe('git-conflict');
    // No binding written on refusal.
    expect((await readLocalRegistry(stackHome)).bindings).toEqual([]);
  });

  it('reports a missing project and a non-directory target', async () => {
    const stackHome = await seedRegistry([localItem('C--x-y', 'n.md')]);
    expect(
      (
        await mapProject({
          stackHome,
          selector: 'prj_doesnotexist000000000000',
          dir: '.',
          gitOrigin: noGit,
        })
      ).status,
    ).toBe('project-not-found');
    const registry0 = await readLocalRegistry(stackHome);
    const projectId = registry0.projects[0]?.projectId as string;
    expect(
      (
        await mapProject({
          stackHome,
          selector: projectId,
          dir: path.join(tmpdir(), 'stack-does-not-exist-xyz'),
          gitOrigin: noGit,
        })
      ).status,
    ).toBe('not-a-directory');
  });
});

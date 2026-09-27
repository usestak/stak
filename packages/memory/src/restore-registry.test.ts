import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from './domain.js';
import { encodeClaudeProjectKey } from './project-identity.js';
import {
  emptyRegistry,
  setBinding,
  type LocalRegistry,
} from './project/registry.js';
import { planMemoryRestore, runMemoryRestore } from './restore.js';
import { hashBytes, writeMemoryManifest, writeMemoryObject } from './store.js';

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

const gitProject = (canonical: string) => ({
  kind: 'git' as const,
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});

const seed = async (
  items: Array<{
    project: ManifestItem['project'];
    rel: string;
    body: string;
  }>,
): Promise<string> => {
  const stackHome = await tempDir('stack-rr-');
  const manifestItems: ManifestItem[] = [];
  for (const { project, rel, body } of items) {
    const bytes = Buffer.from(body, 'utf8');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    const key =
      project?.kind === 'git'
        ? project.canonical
        : `local:${project?.kind === 'local' ? project.vendorKey : ''}`;
    manifestItems.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/${key}/${rel}`,
      ...(project ? { project } : {}),
      contentHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: rel },
      capturedAt: '2026-09-27T00:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items: manifestItems,
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

describe('registry-driven restore resolution', () => {
  it('a Git-backed project auto-resolves across a DIFFERENT local path', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-moved-'); // a new, different path

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    expect(plan.items[0]?.status).toBe('restored');
    const written = await readFile(
      autoMemoryPath(claudeHome, atlasDir, 'a.md'),
      'utf8',
    );
    expect(written).toBe('atlas');
  });

  it('a legacy local identity does NOT auto-resolve from exact path reuse', async () => {
    // Old Memory for a project that used to live here.
    const reusedDir = await tempDir('nexus-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(reusedDir));
    const stackHome = await seed([
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'old-nexus' },
    ]);
    const claudeHome = await tempDir('stack-ch-');

    // An UNRELATED project now sits at the exact same path (no git identity).
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [{ dir: reusedDir }],
    });
    expect(plan.items[0]?.status).toBe('project-not-found');
    // Absolutely nothing was written for the reused directory.
    await expect(
      readFile(autoMemoryPath(claudeHome, reusedDir, 'n.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('an explicit machine binding authorizes restore of a legacy project', async () => {
    const oldDir = 'C--Users-OLD-Desktop-widget';
    const stackHome = await seed([
      {
        project: { kind: 'local', vendorKey: oldDir },
        rel: 'w.md',
        body: 'widget',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const newDir = await tempDir('widget-new-');

    // Register the legacy project and bind it to the new directory.
    const { syncRegistryForBackup } =
      await import('./project/registry-store.js');
    let counter = 0;
    const sync = await syncRegistryForBackup({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    let registry: LocalRegistry = sync.registry;
    const projectId = registry.projects[0]?.projectId as string;
    registry = setBinding(registry, {
      projectId,
      dir: newDir,
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [],
    });
    expect(plan.items[0]?.status).toBe('restored');
    expect(
      await readFile(autoMemoryPath(claudeHome, newDir, 'w.md'), 'utf8'),
    ).toBe('widget');
  });

  it('restores resolvable projects and retains unresolved ones; second restore is idempotent', async () => {
    const legacyDir = await tempDir('legacy-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(legacyDir));
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'nexus' },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');

    const opts = {
      stackHome,
      claudeHome,
      registry: emptyRegistry(),
      projects: [
        { dir: atlasDir, gitRemote: 'git@github.com:acme/atlas.git' },
        { dir: legacyDir }, // path reuse — must NOT resolve the legacy identity
      ],
    };
    const first = await runMemoryRestore({ ...opts, apply: true });
    const statuses = first.items.map((i) => i.status).sort();
    expect(statuses).toEqual(['project-not-found', 'restored']);

    const second = await runMemoryRestore({ ...opts, apply: true });
    const statuses2 = second.items.map((i) => i.status).sort();
    // The restored file is now identical; the unresolved one stays retained.
    expect(statuses2).toEqual(['identical', 'project-not-found']);
  });

  it('never overwrites differing existing memory (conflict semantics intact)', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'new',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const target = autoMemoryPath(claudeHome, atlasDir, 'a.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'PRE-EXISTING', 'utf8');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [{ dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' }],
    });
    expect(plan.items[0]?.status).toBe('conflict');
    expect(await readFile(target, 'utf8')).toBe('PRE-EXISTING');
  });

  it('refuses restore when a strong identity is claimed by two projects', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const registry: LocalRegistry = {
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
    const plan = await planMemoryRestore({
      stackHome,
      claudeHome,
      registry,
      projects: [{ dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' }],
    });
    expect(plan.items[0]?.status).toBe('identity-conflict');
  });

  it('resolves a generation-3-style bundle (git + legacy) without rewriting it', async () => {
    const legacyDir = await tempDir('gen3-legacy-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(legacyDir));
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'nexus' },
    ]);
    // No snapshot present (old generation). Reconcile lazily mints Project IDs.
    const { reconcileRegistryAfterRecover } =
      await import('./project/registry-store.js');
    let counter = 0;
    const { registry } = await reconcileRegistryAfterRecover({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    expect(registry.projects).toHaveLength(2);

    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const plan = await planMemoryRestore({
      stackHome,
      claudeHome,
      registry,
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' },
        { dir: legacyDir },
      ],
    });
    const byRel = Object.fromEntries(
      plan.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(byRel['a.md']).toBe('restorable'); // git resolves
    expect(byRel['n.md']).toBe('project-not-found'); // legacy stays unresolved
  });
});

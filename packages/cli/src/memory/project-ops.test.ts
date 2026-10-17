import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '@stack/memory';
import {
  encodeClaudeProjectKey,
  hashBytes,
  memoryStorePaths,
  planMemoryBackupComposition,
  readLocalRegistry,
  readPortableSnapshot,
  runMemoryRestore,
  syncRegistryForBackup,
  writeMemoryManifest,
  writeMemoryObject,
} from '@stack/memory';

import { renderProjectList } from '../commands/project.js';
import {
  listProjects,
  mapProject,
  setProjectLifecycle,
} from './project-ops.js';

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
const gitProject = (canonical: string) => ({
  kind: 'git' as const,
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
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

/* -------------------------------------------------------------------------- */
/* 15B.2 — legacy project identification UX                                     */
/* -------------------------------------------------------------------------- */

const seedWithObjects = async (
  specs: Array<{ project: ManifestItem['project']; rel: string; body: string }>,
): Promise<string> => {
  const stackHome = await tempDir('stack-pops2-');
  const items: ManifestItem[] = [];
  for (const { project, rel, body } of specs) {
    const bytes = Buffer.from(body, 'utf8');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    const key =
      project?.kind === 'git'
        ? project.canonical
        : `local:${project?.kind === 'local' ? project.vendorKey : ''}`;
    items.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/${key}/${rel}`,
      ...(project ? { project } : {}),
      contentHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: rel },
      capturedAt: '2026-09-28T00:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-28T00:00:00.000Z',
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

const autoMemoryPath = (claudeHome: string, dir: string, rel: string) =>
  path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(path.resolve(dir)),
    'memory',
    rel,
  );

describe('legacy project identification (15B.2)', () => {
  it('shows a legacy project’s historical recovery reference in list output and JSON', async () => {
    const stackHome = await seedRegistry([
      localItem('C--Users-NT-Desktop-stack', 's.md'),
    ]);
    const rows = await listProjects({ stackHome });
    expect(rows[0]?.recoveryReference).toEqual({
      kind: 'legacy-local',
      value: 'local:C--Users-NT-Desktop-stack',
    });
    // Human output surfaces it as informational provenance.
    expect(renderProjectList(rows)).toContain(
      'recovered from: local:C--Users-NT-Desktop-stack',
    );
  });

  it('keeps two same-file-count legacy projects distinguishable by their references', async () => {
    const stackHome = await seedRegistry([
      localItem('C--Users-NT-Desktop-stack', 'a.md'),
      localItem('C--Users-NT-Desktop-stack', 'b.md'),
      localItem('C--Users-NT-Desktop-widget', 'a.md'),
      localItem('C--Users-NT-Desktop-widget', 'b.md'),
    ]);
    const rows = await listProjects({ stackHome });
    const locals = rows.filter((r) => r.identity.kind === 'local');
    expect(locals).toHaveLength(2);
    // Same file count, yet the references tell them apart.
    expect(new Set(locals.map((r) => r.files))).toEqual(new Set([2]));
    expect(new Set(locals.map((r) => r.recoveryReference?.value)).size).toBe(2);
  });

  it('a Git-backed project has no recovery reference', async () => {
    const stackHome = await seedRegistry([
      gitItem('github.com/acme/atlas', 'a.md'),
    ]);
    const rows = await listProjects({ stackHome });
    expect(rows[0]?.identity.kind).toBe('git');
    expect(rows[0]?.recoveryReference).toBeNull();
  });

  it('the recovery reference is never written to the portable registry snapshot', async () => {
    const stackHome = await seedRegistry([
      localItem('C--Users-NT-Desktop-stack', 's.md'),
    ]);
    // Listing computes the reference locally; it must not have been persisted.
    await listProjects({ stackHome });
    const snapshot = JSON.stringify(await readPortableSnapshot(stackHome));
    expect(snapshot).not.toContain('C--Users-NT-Desktop-stack');
    expect(snapshot).not.toContain('recoveryReference');
    expect(snapshot).not.toContain('recovered from');
  });

  it('showing the reference does not change restore resolution; path reuse stays non-authoritative', async () => {
    // The legacy project's historical reference IS shown, and a live directory sits at
    // the exact historical path — restore must still refuse without an explicit map.
    const historicalDir = await tempDir('shown-history-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(historicalDir));
    const stackHome = await seedWithObjects([
      {
        project: { kind: 'local', vendorKey },
        rel: 'h.md',
        body: 'legacy body',
      },
    ]);
    const rows = await listProjects({
      stackHome,
      projects: [{ dir: historicalDir }],
    });
    expect(rows[0]?.recoveryReference?.value).toBe(`local:${vendorKey}`);

    const claudeHome = await tempDir('claude-');
    const registry = await readLocalRegistry(stackHome);
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [{ dir: historicalDir }], // live dir at the shown historical path
    });
    expect(plan.items[0]?.status).toBe('project-not-found');
    await expect(
      readFile(autoMemoryPath(claudeHome, historicalDir, 'h.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('dogfood fixture: distinguishable legacy projects; only the explicitly mapped one restores', async () => {
    const stackDir = await tempDir('stack-proj-');
    const otherDir = await tempDir('other-proj-');
    const stackKey = encodeClaudeProjectKey(path.resolve(stackDir));
    const otherKey = encodeClaudeProjectKey(path.resolve(otherDir));
    const stackHome = await seedWithObjects([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas1',
      },
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'b.md',
        body: 'atlas2',
      },
      {
        project: { kind: 'local', vendorKey: stackKey },
        rel: 's1.md',
        body: 's1',
      },
      {
        project: { kind: 'local', vendorKey: stackKey },
        rel: 's2.md',
        body: 's2',
      },
      {
        project: { kind: 'local', vendorKey: otherKey },
        rel: 'o1.md',
        body: 'o1',
      },
      {
        project: { kind: 'local', vendorKey: otherKey },
        rel: 'o2.md',
        body: 'o2',
      },
      {
        project: { kind: 'local', vendorKey: 'C--legacy-nexus' },
        rel: 'n1.md',
        body: 'n1',
      },
      {
        project: { kind: 'local', vendorKey: 'C--legacy-nexus' },
        rel: 'n2.md',
        body: 'n2',
      },
      {
        project: { kind: 'local', vendorKey: 'C--legacy-nexus' },
        rel: 'n3.md',
        body: 'n3',
      },
      {
        project: { kind: 'local', vendorKey: 'C--legacy-nexus' },
        rel: 'n4.md',
        body: 'n4',
      },
    ]);

    const rows = await listProjects({ stackHome });
    const locals = rows.filter((r) => r.identity.kind === 'local');
    // The two 2-file projects are distinguishable by reference, not file count.
    const twoFile = locals.filter((r) => r.files === 2);
    expect(twoFile).toHaveLength(2);
    expect(new Set(twoFile.map((r) => r.recoveryReference?.value)).size).toBe(
      2,
    );
    // No legacy project is available (no binding, no git).
    for (const row of locals) expect(row.availability).toBe('unavailable');

    // Recognize the Stack-like project by its reference and map it explicitly.
    const stackRow = locals.find((r) =>
      r.recoveryReference?.value.includes(stackKey),
    );
    expect(stackRow).toBeDefined();
    const mapped = await mapProject({
      stackHome,
      selector: stackRow?.projectId as string,
      dir: stackDir,
      gitOrigin: noGit,
    });
    expect(mapped.status).toBe('mapped');

    const claudeHome = await tempDir('claude-');
    const registry = await readLocalRegistry(stackHome);
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [], // no git candidates; atlas stays unavailable here
    });
    const byRel = Object.fromEntries(
      plan.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    // Only the mapped Stack-like project restores.
    expect(byRel['s1.md']).toBe('restored');
    expect(byRel['s2.md']).toBe('restored');
    expect(byRel['o1.md']).toBe('project-not-found');
    expect(byRel['n1.md']).toBe('project-not-found');

    // No filesystem path became portable identity.
    const snapshot = JSON.stringify(await readPortableSnapshot(stackHome));
    expect(snapshot).not.toContain(stackKey);
    expect(snapshot).not.toContain('bindings');
  });
});

describe('read-only command purity (15B.4)', () => {
  it('listProjects and backup-composition preview never mutate registry/store files', async () => {
    const stackHome = await seedWithObjects([
      { project: gitProject('github.com/acme/atlas'), rel: 'a.md', body: 'A' },
      {
        project: { kind: 'local', vendorKey: 'C--legacy-nexus' },
        rel: 'n.md',
        body: 'N',
      },
    ]);
    const paths = memoryStorePaths(stackHome);
    const snapshotState = async () => ({
      local: await readFile(paths.localProjectRegistry),
      registry: await readFile(paths.projectRegistrySnapshot),
      manifest: await readFile(paths.currentManifest),
    });
    const before = await snapshotState();

    // Read-only operations, repeated (mirrors `stack project`, `--json`, and the
    // three `memory backup --dry-run` variants which all route through these).
    for (let i = 0; i < 3; i += 1) {
      await listProjects({
        stackHome,
        projects: [
          {
            dir: '/somewhere/atlas',
            gitRemote: 'https://github.com/acme/atlas.git',
          },
        ],
      });
      await planMemoryBackupComposition({
        stackHome,
        nativeItems: [],
        registry: await readLocalRegistry(stackHome),
        projects: [],
      });
    }

    const after = await snapshotState();
    expect(after.local.equals(before.local)).toBe(true);
    expect(after.registry.equals(before.registry)).toBe(true);
    expect(after.manifest.equals(before.manifest)).toBe(true);
  });
});

describe('project lifecycle (15C)', () => {
  const idOf = async (stackHome: string) =>
    (await readLocalRegistry(stackHome)).projects[0]?.projectId as string;

  it('projects are active by default; archive/unarchive flip lifecycle (idempotent)', async () => {
    const stackHome = await seedRegistry([localItem('C--x-y', 'n.md')]);
    const id = await idOf(stackHome);
    expect((await listProjects({ stackHome }))[0]?.lifecycle).toBe('active');

    const a = await setProjectLifecycle({
      stackHome,
      selector: id,
      lifecycle: 'archived',
    });
    expect(a).toMatchObject({
      status: 'ok',
      lifecycle: 'archived',
      changed: true,
    });
    expect((await listProjects({ stackHome }))[0]?.lifecycle).toBe('archived');

    // Idempotent archive.
    expect(
      await setProjectLifecycle({
        stackHome,
        selector: id,
        lifecycle: 'archived',
      }),
    ).toMatchObject({ status: 'ok', changed: false });

    const u = await setProjectLifecycle({
      stackHome,
      selector: id,
      lifecycle: 'active',
    });
    expect(u).toMatchObject({
      status: 'ok',
      lifecycle: 'active',
      changed: true,
    });
    expect(
      await setProjectLifecycle({
        stackHome,
        selector: id,
        lifecycle: 'active',
      }),
    ).toMatchObject({ status: 'ok', changed: false });
  });

  it('an ambiguous selector fails closed; an unknown selector is not-found', async () => {
    const stackHome = await seedRegistry([
      localItem('C--a', 'a.md'),
      localItem('C--b', 'b.md'),
    ]);
    // Every minted id shares the prj_ prefix, so a bare prefix is ambiguous.
    expect(
      (
        await setProjectLifecycle({
          stackHome,
          selector: 'prj_',
          lifecycle: 'archived',
        })
      ).status,
    ).toBe('ambiguous-selector');
    expect(
      (
        await setProjectLifecycle({
          stackHome,
          selector: 'prj_zzzzzzzzzzzzzzzzzzzzzzzzzz',
          lifecycle: 'archived',
        })
      ).status,
    ).toBe('project-not-found');
  });

  it('archive preserves the Project ID and Memory references', async () => {
    const stackHome = await seedRegistry([
      localItem('C--x-y', 'n1.md'),
      localItem('C--x-y', 'n2.md'),
    ]);
    const id = await idOf(stackHome);
    await setProjectLifecycle({
      stackHome,
      selector: id,
      lifecycle: 'archived',
    });
    const row = (await listProjects({ stackHome }))[0];
    expect(row?.projectId).toBe(id);
    expect(row?.files).toBe(2); // Memory references preserved
  });

  it('lifecycle is independent of availability (all four combinations)', async () => {
    // Atlas has a Git candidate → available; the local project has none → unavailable.
    const stackHome = await seedRegistry([
      gitItem('github.com/acme/atlas', 'a.md'),
      localItem('C--nexus', 'n.md'),
    ]);
    const candidates = [
      { dir: '/x/atlas', gitRemote: 'https://github.com/acme/atlas.git' },
    ];
    const registry = await readLocalRegistry(stackHome);
    const { resolveProjectForIdentity } = await import('@stack/memory');
    const nexusId =
      resolveProjectForIdentity(registry, {
        kind: 'local',
        vendorKey: 'C--nexus',
      }).status === 'resolved'
        ? (
            resolveProjectForIdentity(registry, {
              kind: 'local',
              vendorKey: 'C--nexus',
            }) as { status: 'resolved'; projectId: string }
          ).projectId
        : '';

    // active + available (atlas) and active + unavailable (nexus).
    let rows = await listProjects({ stackHome, projects: candidates });
    const atlas = () =>
      rows.find((r) => r.identity.kind === 'git') as (typeof rows)[number];
    const nexus = () =>
      rows.find((r) => r.identity.kind === 'local') as (typeof rows)[number];
    expect(atlas()).toMatchObject({
      lifecycle: 'active',
      availability: 'present',
    });
    expect(nexus()).toMatchObject({
      lifecycle: 'active',
      availability: 'unavailable',
    });

    // Archive nexus → archived + unavailable (availability unchanged).
    await setProjectLifecycle({
      stackHome,
      selector: nexusId,
      lifecycle: 'archived',
    });
    rows = await listProjects({ stackHome, projects: candidates });
    expect(nexus()).toMatchObject({
      lifecycle: 'archived',
      availability: 'unavailable',
    });
    // Atlas stays active + available regardless.
    expect(atlas()).toMatchObject({
      lifecycle: 'active',
      availability: 'present',
    });
  });

  it('mapping an archived project makes it available but does NOT change lifecycle', async () => {
    const dir = await tempDir('nexus-here-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(dir));
    const stackHome = await seedWithObjects([
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'N' },
    ]);
    const id = await idOf(stackHome);
    await setProjectLifecycle({
      stackHome,
      selector: id,
      lifecycle: 'archived',
    });

    // archived + unavailable → map → archived + available.
    expect((await listProjects({ stackHome }))[0]).toMatchObject({
      lifecycle: 'archived',
      availability: 'unavailable',
    });
    const mapped = await mapProject({
      stackHome,
      selector: id,
      dir,
      gitOrigin: noGit,
    });
    expect(mapped.status).toBe('mapped');
    const row = (await listProjects({ stackHome }))[0];
    expect(row).toMatchObject({
      lifecycle: 'archived',
      availability: 'present',
    });
  });
});

describe('discoveredName (project-naming UX, recovery path)', () => {
  it('surfaces a persisted discovery-time name hint even when the project is unmapped', async () => {
    const stackHome = await tempDir('stack-pops-');
    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-09-27T00:00:00.000Z',
      items: [localItem('C--Users-NT-Desktop-nexus', 'n1.md')],
    };
    await writeMemoryManifest({ stackHome, manifest });
    await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const rows = await listProjects({ stackHome });
    expect(rows[0]?.discoveredName).toBe('nexus');
    expect(rows[0]?.binding).toBeNull();
    expect(rows[0]?.availability).toBe('unavailable');
  });

  it('is null when no hint was ever captured', async () => {
    const stackHome = await seedRegistry([
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const rows = await listProjects({ stackHome });
    expect(rows[0]?.discoveredName).toBeNull();
  });
});

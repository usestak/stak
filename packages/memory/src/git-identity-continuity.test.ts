import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeMemoryAdapter, readMemoryStatus } from './adapter.js';
import { planMemoryBackupComposition } from './backup.js';
import { discoverClaudeMemory } from './claude-adapter.js';
import { readLocalRegistry } from './project/registry-store.js';
import { memoryStorePaths } from './store.js';
import type { ManifestItem, MemoryManifest } from './domain.js';
import {
  encodeClaudeProjectKey,
  reconstructProjectDir,
  reconstructProjectDirs,
} from './project-identity.js';
import { syncRegistryForBackup } from './project/registry-store.js';
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

const isDirectory = async (candidate: string): Promise<boolean> => {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

describe('reconstructProjectDir', () => {
  it('recovers a real path whose leaf name contains hyphens', async () => {
    // Build a real nested directory whose last component has hyphens.
    const base = await tempDir('recon-');
    const projectDir = path.join(base, 'repos', 'atlas-access-flow');
    await mkdir(projectDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(projectDir);
    const resolved = await reconstructProjectDir({
      vendorKey,
      isDirectory,
      platform: process.platform,
    });
    expect(resolved).not.toBeNull();
    expect(path.resolve(resolved as string)).toBe(path.resolve(projectDir));
  });

  it('returns null when the path cannot be reconstructed', async () => {
    const resolved = await reconstructProjectDir({
      vendorKey:
        process.platform === 'win32'
          ? 'Z--nope-nope-nowhere-xyz'
          : '-nope-nope-nowhere-xyz',
      isDirectory,
      platform: process.platform,
    });
    expect(resolved).toBeNull();
  });
});

describe('reconstructProjectDir ambiguity (15B.4 closure)', () => {
  // Deterministic, cross-platform: a synthetic win32 filesystem given as an exact set
  // of existing directories, so ordering/host FS never influences the result.
  const win = path.win32;
  const fakeDirs = (existing: string[]) => {
    const set = new Set(existing);
    return async (candidate: string) => set.has(candidate);
  };

  it('1. resolves one unambiguous hyphenated project path', async () => {
    const isDir = fakeDirs([
      win.join('C:\\', 'repos'),
      win.join('C:\\', 'repos', 'atlas-access-flow'),
    ]);
    const resolved = await reconstructProjectDir({
      vendorKey: 'C--repos-atlas-access-flow',
      isDirectory: isDir,
      platform: 'win32',
    });
    expect(resolved).toBe(win.join('C:\\', 'repos', 'atlas-access-flow'));
  });

  it('2. resolves nested hyphenated directories unambiguously', async () => {
    const isDir = fakeDirs([
      win.join('C:\\', 'my-repos'),
      win.join('C:\\', 'my-repos', 'atlas-access-flow'),
    ]);
    const resolved = await reconstructProjectDir({
      vendorKey: 'C--my-repos-atlas-access-flow',
      isDirectory: isDir,
      platform: 'win32',
    });
    expect(resolved).toBe(win.join('C:\\', 'my-repos', 'atlas-access-flow'));
  });

  it('3. picks no arbitrary winner when two reconstructions both exist', async () => {
    // Key "C--a-b-c" decodes to BOTH C:\a-b\c and C:\a\b-c.
    const isDir = fakeDirs([
      win.join('C:\\', 'a-b'),
      win.join('C:\\', 'a-b', 'c'),
      win.join('C:\\', 'a'),
      win.join('C:\\', 'a', 'b-c'),
    ]);
    const all = await reconstructProjectDirs({
      vendorKey: 'C--a-b-c',
      isDirectory: isDir,
      platform: 'win32',
    });
    expect(all.sort()).toEqual(
      [win.join('C:\\', 'a-b', 'c'), win.join('C:\\', 'a', 'b-c')].sort(),
    );
    // Fail closed: no single winner is chosen.
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--a-b-c',
        isDirectory: isDir,
        platform: 'win32',
      }),
    ).toBeNull();
  });

  it('4/5. ambiguous decodings never authorize a Git identity (probe is not consulted)', async () => {
    // Two real, simultaneously existing decodings of one vendor key. Discovery must
    // fall back to a local identity and must NOT call the Git probe.
    const claudeHome = await tempDir('claude-');
    const base = await tempDir('base-');
    // base/a-b/c  and  base/a/b-c both exist → both encode to the same vendor key.
    const decodeA = path.join(base, 'a-b', 'c');
    const decodeB = path.join(base, 'a', 'b-c');
    await mkdir(decodeA, { recursive: true });
    await mkdir(decodeB, { recursive: true });
    expect(encodeClaudeProjectKey(decodeA)).toBe(
      encodeClaudeProjectKey(decodeB),
    );
    const vendorKey = encodeClaudeProjectKey(decodeA);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'm.md'), 'm\n', 'utf8');

    let probed = false;
    const items = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async () => {
        probed = true;
        return 'https://github.com/example/whatever.git';
      },
      isDirectory,
      platform: process.platform,
    });
    expect(items[0]?.project?.kind).toBe('local'); // conservative fallback
    expect(probed).toBe(false); // ambiguity resolved before any Git probe
  });

  it('6. non-existent path yields no reconstruction', async () => {
    const none = fakeDirs([]);
    expect(
      await reconstructProjectDirs({
        vendorKey: 'C--no-such-place',
        isDirectory: none,
        platform: 'win32',
      }),
    ).toEqual([]);
  });

  it('7. resolves an ordinary Windows drive path', async () => {
    const isDir = fakeDirs([
      win.join('C:\\', 'Users'),
      win.join('C:\\', 'Users', 'NT'),
      win.join('C:\\', 'Users', 'NT', 'project'),
    ]);
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--Users-NT-project',
        isDirectory: isDir,
        platform: 'win32',
      }),
    ).toBe(win.join('C:\\', 'Users', 'NT', 'project'));
  });

  it('8. matching is delegated to isDirectory (no case folding of its own)', async () => {
    // The reconstructor never case-folds; case behavior is whatever the injected
    // predicate (the real filesystem) does. A case-sensitive predicate that only
    // knows the lowercase path does not match a differently-cased key.
    const isDir = fakeDirs([
      win.join('C:\\', 'repos'),
      win.join('C:\\', 'repos', 'atlas'),
    ]);
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--Repos-Atlas',
        isDirectory: isDir,
        platform: 'win32',
      }),
    ).toBeNull();
  });
});

describe('Git identity continuity across restored native memory (15B.4)', () => {
  // A native auto-memory project under a machine-specific vendor key whose checkout
  // carries a strong Git remote must resolve to that Git identity — with NO passed
  // candidate — so scan and backup agree regardless of the working directory.
  const seedNativeClaude = async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'atlas-access-flow');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'a1.md'), '# atlas 1\n', 'utf8');
    await writeFile(path.join(memoryDir, 'a2.md'), '# atlas 2\n', 'utf8');
    const gitRemoteOf = async (dir: string) =>
      path.resolve(dir) === path.resolve(checkout)
        ? 'https://github.com/example/atlas.git'
        : undefined;
    return { claudeHome, checkout, gitRemoteOf };
  };

  it('resolves native auto-memory to its Git identity via the checkout, without candidates', async () => {
    const { claudeHome, gitRemoteOf } = await seedNativeClaude();
    const items = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf,
      isDirectory,
      platform: process.platform,
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.project?.kind).toBe('git');
      if (item.project?.kind === 'git')
        expect(item.project.canonical).toBe('github.com/example/atlas');
      // Never a local, path-derived identity.
      expect(item.logicalId).toContain('github.com/example/atlas');
    }
  });

  it('backup composition does not mint a second local project or double-count Git memory', async () => {
    const { claudeHome, gitRemoteOf } = await seedNativeClaude();

    // Previous (recovered) backup: Git-keyed Atlas (2) + an unavailable legacy Nexus (2).
    const stackHome = await tempDir('stack-');
    const previous: ManifestItem[] = [];
    const addItem = async (
      project: ManifestItem['project'],
      rel: string,
      body: string,
    ) => {
      const bytes = Buffer.from(body, 'utf8');
      await writeMemoryObject({
        stackHome,
        contentHash: hashBytes(bytes),
        bytes,
      });
      const key =
        project?.kind === 'git'
          ? project.canonical
          : `local:${project?.kind === 'local' ? project.vendorKey : ''}`;
      previous.push({
        provider: 'claude',
        kind: 'auto-memory',
        scope: 'project',
        logicalId: `claude/auto-memory/${key}/${rel}`,
        ...(project ? { project } : {}),
        contentHash: hashBytes(bytes),
        restoreTarget: { base: 'claude-project-memory', relativePath: rel },
        capturedAt: '2026-09-28T00:00:00.000Z',
        sensitivity: 'private',
      });
    };
    const atlas = {
      kind: 'git' as const,
      canonical: 'github.com/example/atlas',
      host: 'github.com',
      owner: 'example',
      repo: 'atlas',
    };
    await addItem(atlas, 'a1.md', '# atlas 1\n');
    await addItem(atlas, 'a2.md', '# atlas 2\n');
    await addItem(
      { kind: 'local', vendorKey: 'C--legacy-nexus' },
      'n1.md',
      'n1',
    );
    await addItem(
      { kind: 'local', vendorKey: 'C--legacy-nexus' },
      'n2.md',
      'n2',
    );
    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-09-28T00:00:00.000Z',
      items: previous,
    };
    await writeMemoryManifest({ stackHome, manifest });
    let counter = 0;
    const { registry } = await syncRegistryForBackup({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    expect(registry.projects).toHaveLength(2); // Atlas(git) + Nexus(local)

    // Native scan resolves Atlas by its checkout Git identity (cwd-independent).
    const nativeItems = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf,
      isDirectory,
      platform: process.platform,
    });

    const composition = await planMemoryBackupComposition({
      stackHome,
      nativeItems,
      registry,
      claudeHome: await tempDir('claude-plan-'),
      projects: [], // deliberately NO candidate — resolution must not depend on it
    });

    // Atlas native items overlay the recovered Git items (same logical ids) — not
    // carried again; Nexus is unavailable and carried once. No second Atlas project.
    expect(composition.nativeFiles).toBe(2);
    expect(composition.retainedFiles).toBe(2); // Nexus only
    expect(composition.finalFiles).toBe(4); // NOT 6
    expect(composition.finalProjects).toBe(2); // Atlas + Nexus, NOT 3
    const carriedKeys = composition.carriedForward.map((i) =>
      i.logicalId.split('/').slice(2, -1).join('/'),
    );
    expect(carriedKeys.every((k) => k.startsWith('local:'))).toBe(true);
    // No native item carries a local Atlas identity.
    expect(
      nativeItems.every((i) =>
        i.logicalId.includes('github.com/example/atlas'),
      ),
    ).toBe(true);
  });

  it('adapter.backup keeps native Git memory in the existing project and carries Nexus once', async () => {
    const { claudeHome, gitRemoteOf } = await seedNativeClaude();
    const stackHome = await tempDir('stack-');

    // Recovered previous backup: Git-keyed Atlas (2) + unavailable Nexus (2).
    const previous: ManifestItem[] = [];
    const add = async (
      project: ManifestItem['project'],
      rel: string,
      body: string,
    ) => {
      const bytes = Buffer.from(body, 'utf8');
      await writeMemoryObject({
        stackHome,
        contentHash: hashBytes(bytes),
        bytes,
      });
      const key =
        project?.kind === 'git'
          ? project.canonical
          : `local:${project?.kind === 'local' ? project.vendorKey : ''}`;
      previous.push({
        provider: 'claude',
        kind: 'auto-memory',
        scope: 'project',
        logicalId: `claude/auto-memory/${key}/${rel}`,
        ...(project ? { project } : {}),
        contentHash: hashBytes(bytes),
        restoreTarget: { base: 'claude-project-memory', relativePath: rel },
        capturedAt: '2026-09-28T00:00:00.000Z',
        sensitivity: 'private',
      });
    };
    const atlas = {
      kind: 'git' as const,
      canonical: 'github.com/example/atlas',
      host: 'github.com',
      owner: 'example',
      repo: 'atlas',
    };
    await add(atlas, 'a1.md', '# atlas 1\n');
    await add(atlas, 'a2.md', '# atlas 2\n');
    await add({ kind: 'local', vendorKey: 'C--legacy-nexus' }, 'n1.md', 'n1');
    await add({ kind: 'local', vendorKey: 'C--legacy-nexus' }, 'n2.md', 'n2');
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-28T00:00:00.000Z',
        items: previous,
      },
    });
    await syncRegistryForBackup({ stackHome });

    // No candidate projects passed: resolution must come from the checkout probe.
    const adapter = createClaudeMemoryAdapter({
      stackHome,
      claudeHome,
      gitRemoteOf,
      isDirectory,
      platform: process.platform,
    });

    const preview = await adapter.previewBackup();
    expect(preview.finalFiles).toBe(4);
    expect(preview.finalProjects).toBe(2);
    expect(preview.retainedFiles).toBe(2);

    await adapter.backup();
    const registry = await readLocalRegistry(stackHome);
    // Exactly two logical projects — no second local Atlas identity was minted.
    expect(registry.projects).toHaveLength(2);
    const gitProjects = registry.projects.filter((r) =>
      r.claims.some((c) => c.type === 'git'),
    );
    expect(gitProjects).toHaveLength(1);
  });

  it('read-only handlers (scan, backup preview, restore dry-run, status) never mutate registry files', async () => {
    const { claudeHome, gitRemoteOf } = await seedNativeClaude();
    const stackHome = await tempDir('stack-');
    // A prior backup exists so the registry + snapshot files are present.
    const bytes = Buffer.from('# atlas 1\n', 'utf8');
    await writeMemoryObject({
      stackHome,
      contentHash: hashBytes(bytes),
      bytes,
    });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-28T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/example/atlas/a1.md',
            project: {
              kind: 'git',
              canonical: 'github.com/example/atlas',
              host: 'github.com',
              owner: 'example',
              repo: 'atlas',
            },
            contentHash: hashBytes(bytes),
            restoreTarget: {
              base: 'claude-project-memory',
              relativePath: 'a1.md',
            },
            capturedAt: '2026-09-28T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await syncRegistryForBackup({ stackHome });

    const adapter = createClaudeMemoryAdapter({
      stackHome,
      claudeHome,
      gitRemoteOf,
      isDirectory,
      platform: process.platform,
    });
    const paths = memoryStorePaths(stackHome);
    const capture = async () => ({
      local: await (
        await import('node:fs/promises')
      ).readFile(paths.localProjectRegistry),
      snapshot: await (
        await import('node:fs/promises')
      ).readFile(paths.projectRegistrySnapshot),
      manifest: await (
        await import('node:fs/promises')
      ).readFile(paths.currentManifest),
    });
    const before = await capture();
    for (let i = 0; i < 2; i += 1) {
      await adapter.discover(); // memory scan
      await adapter.previewBackup(); // memory backup --dry-run
      await adapter.planRestore(); // memory restore --dry-run
      await adapter.restore({ apply: false }); // dry-run apply=false
      await readMemoryStatus(stackHome); // memory status
    }
    const after = await capture();
    expect(after.local.equals(before.local)).toBe(true);
    expect(after.snapshot.equals(before.snapshot)).toBe(true);
    expect(after.manifest.equals(before.manifest)).toBe(true);
  });

  it('falls back to a local identity when the checkout has no Git remote (mapping/legacy unaffected)', async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'plain-project');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'p.md'), 'plain\n', 'utf8');
    const items = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async () => undefined, // no remote
      isDirectory,
      platform: process.platform,
    });
    expect(items[0]?.project?.kind).toBe('local');
  });
});

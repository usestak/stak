import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('decodes a dotted-name vendor key back to the dotted directory, and only it', async () => {
    const base = await tempDir('recon-dot-');
    const dottedDir = path.join(base, '.claude-mem');
    await mkdir(dottedDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(dottedDir);
    const resolved = await reconstructProjectDir({
      vendorKey,
      isDirectory,
      platform: process.platform,
    });
    expect(resolved).not.toBeNull();
    expect(path.resolve(resolved as string)).toBe(path.resolve(dottedDir));
  });

  it('traverses a directory junction/symlink (e.g. a C:\\dev -> D:\\dev-style mapping) to locate a project reached through it', async () => {
    // `claude-project-adapter.ts` never rejects a project's own `dir` for being a
    // symlink/junction (only the `~/.claude/projects/<key>` folder itself is
    // guarded) — a real, locatable project reached through one must stay
    // locatable here too, not silently vanish because readdir reports the link
    // entry itself as "not a directory".
    const target = await tempDir('junction-target-');
    const projectDir = path.join(target, 'myproject');
    await mkdir(projectDir, { recursive: true });

    const linkParent = await tempDir('junction-link-');
    const link = path.join(linkParent, 'devlink');
    await symlink(target, link, 'junction');

    const linkedProjectDir = path.join(link, 'myproject');
    const vendorKey = encodeClaudeProjectKey(linkedProjectDir);
    const resolved = await reconstructProjectDir({
      vendorKey,
      isDirectory,
      platform: process.platform,
    });
    expect(resolved).not.toBeNull();
    expect(path.resolve(resolved as string)).toBe(path.resolve(linkedProjectDir));
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
  // `fakeListDirs` derives a parent -> child-NAME map from that flat set (the exact
  // readdir-based walk's one dependency) rather than answering "does this exact
  // candidate path exist" — it drives the new algorithm the same way a real
  // `readdir` would.
  const win = path.win32;
  const fakeListDirs = (existing: string[]) => {
    // Every ANCESTOR of each given path is implicitly real too (as it would be on
    // a real filesystem) — a caller only needs to list the leaf(ves) it cares
    // about, not every intermediate level by hand.
    const allDirs = new Set<string>();
    for (const leaf of existing.map((p) => win.resolve(p))) {
      let current = leaf;
      for (;;) {
        allDirs.add(current);
        const parent = win.dirname(current);
        if (parent === current) break; // reached the root
        current = parent;
      }
    }
    return async (dir: string): Promise<string[]> => {
      const parent = win.resolve(dir);
      const names = new Set<string>();
      for (const candidate of allDirs) {
        if (candidate === parent) continue;
        if (win.dirname(candidate) === parent) names.add(win.basename(candidate));
      }
      return [...names];
    };
  };

  it('1. resolves one unambiguous hyphenated project path', async () => {
    const listDirs = fakeListDirs([
      win.join('C:\\', 'repos'),
      win.join('C:\\', 'repos', 'atlas-access-flow'),
    ]);
    const resolved = await reconstructProjectDir({
      vendorKey: 'C--repos-atlas-access-flow',
      listDirs,
      platform: 'win32',
    });
    expect(resolved).toBe(win.join('C:\\', 'repos', 'atlas-access-flow'));
  });

  it('2. resolves nested hyphenated directories unambiguously', async () => {
    const listDirs = fakeListDirs([
      win.join('C:\\', 'my-repos'),
      win.join('C:\\', 'my-repos', 'atlas-access-flow'),
    ]);
    const resolved = await reconstructProjectDir({
      vendorKey: 'C--my-repos-atlas-access-flow',
      listDirs,
      platform: 'win32',
    });
    expect(resolved).toBe(win.join('C:\\', 'my-repos', 'atlas-access-flow'));
  });

  it('3. picks no arbitrary winner when two reconstructions both exist', async () => {
    // Key "C--a-b-c" decodes to BOTH C:\a-b\c and C:\a\b-c.
    const listDirs = fakeListDirs([
      win.join('C:\\', 'a-b'),
      win.join('C:\\', 'a-b', 'c'),
      win.join('C:\\', 'a'),
      win.join('C:\\', 'a', 'b-c'),
    ]);
    const all = await reconstructProjectDirs({
      vendorKey: 'C--a-b-c',
      listDirs,
      platform: 'win32',
    });
    expect(all.sort()).toEqual(
      [win.join('C:\\', 'a-b', 'c'), win.join('C:\\', 'a', 'b-c')].sort(),
    );
    // Fail closed: no single winner is chosen.
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--a-b-c',
        listDirs,
        platform: 'win32',
      }),
    ).toBeNull();
  });

  it('9. decodes real-world punctuation/Unicode directory names exactly, with no guessing', async () => {
    const realWorldNames = [
      'OneDrive - Acme Corp',
      'my_cool_side_project_v2',
      'New folder (2)',
      'Résumé site',
    ];
    for (const name of realWorldNames) {
      const listDirs = fakeListDirs([win.join('C:\\', 'Users', 'NT', name)]);
      const vendorKey = encodeClaudeProjectKey(win.join('C:\\', 'Users', 'NT', name));
      const resolved = await reconstructProjectDir({ vendorKey, listDirs, platform: 'win32' });
      expect(resolved).toBe(win.join('C:\\', 'Users', 'NT', name));
    }
  });

  it('10. two children with identically-encoding names are ambiguous, not an arbitrary pick', async () => {
    // "a.b" and "a_b" both encode to "a-b" — two real children of the SAME parent
    // that collide. Neither is a parent/child nesting (unlike test 3) — a true
    // sibling collision.
    const listDirs = fakeListDirs([
      win.join('C:\\', 'proj', 'a.b'),
      win.join('C:\\', 'proj', 'a_b'),
    ]);
    const vendorKey = 'C--proj-a-b';
    const all = await reconstructProjectDirs({ vendorKey, listDirs, platform: 'win32' });
    expect(all.sort()).toEqual(
      [win.join('C:\\', 'proj', 'a.b'), win.join('C:\\', 'proj', 'a_b')].sort(),
    );
    expect(await reconstructProjectDir({ vendorKey, listDirs, platform: 'win32' })).toBeNull();
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
    const listDirs = fakeListDirs([]);
    expect(
      await reconstructProjectDirs({
        vendorKey: 'C--no-such-place',
        listDirs,
        platform: 'win32',
      }),
    ).toEqual([]);
  });

  it('7. resolves an ordinary Windows drive path', async () => {
    const listDirs = fakeListDirs([
      win.join('C:\\', 'Users'),
      win.join('C:\\', 'Users', 'NT'),
      win.join('C:\\', 'Users', 'NT', 'project'),
    ]);
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--Users-NT-project',
        listDirs,
        platform: 'win32',
      }),
    ).toBe(win.join('C:\\', 'Users', 'NT', 'project'));
  });

  it('8. on win32, matching is case-INSENSITIVE — NTFS is, and Claude/PowerShell can record either casing for the same real folder', async () => {
    // A directory tree that only has the lowercase real names still matches a
    // differently-cased key — restoring the case-insensitivity the old
    // stat-based walk had for free (via NTFS itself opening any casing), lost by
    // the first exact-walk rewrite and caught on a real `~/.claude/projects` key.
    const listDirs = fakeListDirs([
      win.join('C:\\', 'repos'),
      win.join('C:\\', 'repos', 'atlas'),
    ]);
    expect(
      await reconstructProjectDir({
        vendorKey: 'C--Repos-Atlas',
        listDirs,
        platform: 'win32',
      }),
    ).toBe(win.join('C:\\', 'repos', 'atlas'));
  });

  it('9. on POSIX, matching stays case-SENSITIVE — a differently-cased key does not match', async () => {
    const listDirs = fakeListDirs([
      path.posix.join('/', 'repos'),
      path.posix.join('/', 'repos', 'atlas'),
    ]);
    expect(
      await reconstructProjectDir({
        vendorKey: '-Repos-Atlas',
        listDirs,
        platform: 'linux',
      }),
    ).toBeNull();
  });

  it('10. a differently-cased real-machine key (`c--users-nt-desktop-stack`, as PowerShell can record it) decodes to the real, naturally-cased directory on win32', async () => {
    const base = await tempDir('case-');
    const projectDir = path.join(base, 'Stack');
    await mkdir(projectDir, { recursive: true });
    const naturalKey = encodeClaudeProjectKey(projectDir);
    const differentlyCasedKey = naturalKey.toLowerCase();
    expect(differentlyCasedKey).not.toBe(naturalKey); // sanity: the key actually differs
    const resolved = await reconstructProjectDir({
      vendorKey: differentlyCasedKey,
      isDirectory,
      platform: 'win32',
    });
    expect(resolved).not.toBeNull();
    // Case-INSENSITIVE comparison is the whole point here: `differentlyCasedKey`
    // lowercased the DRIVE LETTER too, so the walk's own root string is `c:\`, not
    // `C:\` — a different STRING, but the identical real directory on NTFS. The
    // walk's job is proving it's the same directory, never canonicalizing casing.
    expect(path.resolve(resolved as string).toLowerCase()).toBe(
      path.resolve(projectDir).toLowerCase(),
    );
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

describe('onLocalProjectResolved hook (discovery-time basename capture)', () => {
  it('fires with the vendor key and the real resolved directory for an unmatched local project with no Git remote', async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'nexus');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'n1.md'), '# nexus\n', 'utf8');

    const resolved: Array<{ vendorKey: string; dir: string }> = [];
    const items = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async () => undefined, // no remote → identity stays local
      isDirectory,
      platform: process.platform,
      onLocalProjectResolved: (key, dir) =>
        resolved.push({ vendorKey: key, dir }),
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.project).toEqual({ kind: 'local', vendorKey });
    expect(resolved).toEqual([{ vendorKey, dir: path.resolve(checkout) }]);
  });

  it('never fires for a project that resolved to a Git identity', async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'atlas-access-flow');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'a1.md'), '# atlas\n', 'utf8');

    const resolved: Array<{ vendorKey: string; dir: string }> = [];
    await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async (dir) =>
        path.resolve(dir) === path.resolve(checkout)
          ? 'https://github.com/example/atlas.git'
          : undefined,
      isDirectory,
      platform: process.platform,
      onLocalProjectResolved: (key, dir) =>
        resolved.push({ vendorKey: key, dir }),
    });

    expect(resolved).toEqual([]);
  });
});

import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateTreePath } from '@stack/shared';

import type {
  DiscoveredMemoryItem,
  MemoryKind,
  ProjectIdentity,
  RestoreTarget,
} from './domain.js';
import { hashBytes } from './store.js';
import {
  canonicalGitIdentity,
  encodeClaudeProjectKey,
  normalizeVendorKey,
  projectIdentityKey,
  reconstructProjectDir,
} from './project-identity.js';

export type ClaudeProjectInput = { dir: string; gitRemote?: string };

export type ClaudeMemoryDiscoveryOptions = {
  claudeHome?: string;
  projects?: ClaudeProjectInput[];
  now?: () => Date;
  /**
   * Filesystem case sensitivity for vendor-key matching. Defaults to the host
   * platform; injectable so matching semantics are deterministic in tests.
   */
  platform?: NodeJS.Platform;
  /**
   * Resolve a directory's canonical Git remote (Phase 15B.4). When provided, an
   * auto-memory project that is not matched by a passed candidate is resolved from
   * its OWN checkout directory (reconstructed from the vendor key), so Git identity
   * is recovered independent of the current working directory — keeping `scan` and
   * `backup` consistent. `isDirectory` validates the reconstructed path.
   */
  gitRemoteOf?: (dir: string) => Promise<string | undefined>;
  isDirectory?: (candidate: string) => Promise<boolean>;
};

export type MemoryDetection = { installed: boolean; reason?: string };

const resolveClaudeHome = (options: ClaudeMemoryDiscoveryOptions): string =>
  path.resolve(options.claudeHome ?? path.join(os.homedir(), '.claude'));

export const detectClaudeMemory = async (
  options: ClaudeMemoryDiscoveryOptions = {},
): Promise<MemoryDetection> => {
  const home = resolveClaudeHome(options);
  try {
    if ((await stat(home)).isDirectory()) return { installed: true };
    return { installed: false, reason: 'Claude home is not a directory.' };
  } catch {
    return {
      installed: false,
      reason: 'No Claude home found on this machine.',
    };
  }
};

/**
 * Enumerate regular files beneath an allowlisted memory root. Symlinks are never
 * followed (defeating escape/traversal), and every path segment is validated.
 */
const walkMemoryFiles = async (
  root: string,
): Promise<Array<{ rel: string; abs: string }>> => {
  const out: Array<{ rel: string; abs: string }> = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        validateTreePath(rel);
      } catch {
        continue; // refuse traversal / unsafe segment names
      }
      const abs = path.join(dir, entry.name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) continue; // never follow symlinks out of the root
      if (stats.isDirectory()) await visit(abs, rel);
      else if (stats.isFile()) out.push({ rel, abs });
    }
  };
  await visit(root, '');
  return out;
};

const fileItem = async (options: {
  abs: string;
  kind: MemoryKind;
  scope: 'global' | 'project';
  logicalId: string;
  restoreTarget: RestoreTarget;
  project?: ProjectIdentity;
  vendorKey?: string;
  now: () => Date;
}): Promise<DiscoveredMemoryItem> => {
  const bytes = await readFile(options.abs);
  return {
    provider: 'claude',
    kind: options.kind,
    scope: options.scope,
    logicalId: options.logicalId,
    ...(options.project ? { project: options.project } : {}),
    contentHash: hashBytes(bytes),
    restoreTarget: options.restoreTarget,
    source: {
      path: options.abs,
      ...(options.vendorKey ? { vendorKey: options.vendorKey } : {}),
    },
    capturedAt: options.now().toISOString(),
    sensitivity: 'private',
  };
};

const localIdentity = (vendorKey: string): ProjectIdentity => ({
  kind: 'local',
  vendorKey,
});

/**
 * Discover Claude durable memory, READ-ONLY, from an allowlisted set of paths:
 *   - <home>/CLAUDE.md                       user instructions (global)
 *   - <home>/agent-memory/<agent>/**         agent memory (global)
 *   - <home>/projects/<key>/memory/**        auto-memory (project)
 *   - <project>/CLAUDE.local.md              project private instructions
 *   - <project>/.claude/agent-memory/<agent>/**   agent memory (project)
 *
 * Everything else under ~/.claude (transcripts, history, todos, caches, auth,
 * settings, plugins, ~/.claude.json) is never traversed.
 */
export const discoverClaudeMemory = async (
  options: ClaudeMemoryDiscoveryOptions = {},
): Promise<DiscoveredMemoryItem[]> => {
  const home = resolveClaudeHome(options);
  const now = options.now ?? (() => new Date());
  const items: DiscoveredMemoryItem[] = [];

  // 1. Global user instructions.
  const userInstructions = path.join(home, 'CLAUDE.md');
  if (await isFile(userInstructions))
    items.push(
      await fileItem({
        abs: userInstructions,
        kind: 'user-instructions',
        scope: 'global',
        logicalId: 'claude/user-instructions/global/CLAUDE.md',
        restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
        now,
      }),
    );

  // 2. Global agent-memory.
  for (const { rel, abs } of await walkMemoryFiles(
    path.join(home, 'agent-memory'),
  ))
    items.push(
      await fileItem({
        abs,
        kind: 'agent-memory',
        scope: 'global',
        logicalId: `claude/agent-memory/global/${rel}`,
        restoreTarget: {
          base: 'claude-home',
          relativePath: `agent-memory/${rel}`,
        },
        now,
      }),
    );

  // 3. Auto-memory per project. Match a known local project (by its
  //    case-normalized encoded key) to attach a portable Git identity; a project
  //    with no usable origin, or no local directory at all, stays unresolved
  //    (local) with its real vendor key preserved.
  const platform = options.platform ?? process.platform;
  const gitByVendorKey = new Map<string, ProjectIdentity>();
  for (const project of options.projects ?? []) {
    const git = canonicalGitIdentity(project.gitRemote);
    if (!git) continue; // no origin → do not resolve; leave as local
    gitByVendorKey.set(
      normalizeVendorKey(encodeClaudeProjectKey(project.dir), platform),
      git,
    );
  }
  const projectsRoot = path.join(home, 'projects');
  for (const vendorKey of await listDirNames(projectsRoot)) {
    const memoryRoot = path.join(projectsRoot, vendorKey, 'memory');
    const files = await walkMemoryFiles(memoryRoot);
    if (files.length === 0) continue;
    // Prefer a candidate match; otherwise resolve strong Git identity from the
    // project's OWN checkout (reconstructed from the vendor key) so a native project
    // with a strong Git identity is never mis-minted as a new local project just
    // because it is not the current working directory (Phase 15B.4).
    let identity =
      gitByVendorKey.get(normalizeVendorKey(vendorKey, platform)) ?? null;
    if (!identity && options.gitRemoteOf && options.isDirectory) {
      const dir = await reconstructProjectDir({
        vendorKey,
        isDirectory: options.isDirectory,
        platform,
      });
      if (dir) {
        const git = canonicalGitIdentity(await options.gitRemoteOf(dir));
        if (git) identity = git;
      }
    }
    identity = identity ?? localIdentity(vendorKey);
    for (const { rel, abs } of files)
      items.push(
        await fileItem({
          abs,
          kind: 'auto-memory',
          scope: 'project',
          logicalId: `claude/auto-memory/${projectIdentityKey(identity)}/${rel}`,
          restoreTarget: { base: 'claude-project-memory', relativePath: rel },
          project: identity,
          vendorKey,
          now,
        }),
      );
  }

  // 4. Project-local instructions + agent-memory for known projects.
  for (const project of options.projects ?? []) {
    const dir = path.resolve(project.dir);
    const vendorKey = encodeClaudeProjectKey(dir);
    const identity =
      canonicalGitIdentity(project.gitRemote) ?? localIdentity(vendorKey);
    const key = projectIdentityKey(identity);

    const projectLocal = path.join(dir, 'CLAUDE.local.md');
    if (await isFile(projectLocal))
      items.push(
        await fileItem({
          abs: projectLocal,
          kind: 'project-private-instructions',
          scope: 'project',
          logicalId: `claude/project-private/${key}/CLAUDE.local.md`,
          restoreTarget: { base: 'project', relativePath: 'CLAUDE.local.md' },
          project: identity,
          vendorKey,
          now,
        }),
      );

    for (const { rel, abs } of await walkMemoryFiles(
      path.join(dir, '.claude', 'agent-memory'),
    ))
      items.push(
        await fileItem({
          abs,
          kind: 'agent-memory',
          scope: 'project',
          logicalId: `claude/agent-memory/${key}/${rel}`,
          restoreTarget: {
            base: 'project',
            relativePath: `.claude/agent-memory/${rel}`,
          },
          project: identity,
          vendorKey,
          now,
        }),
      );
  }

  return items.sort((a, b) => (a.logicalId < b.logicalId ? -1 : 1));
};

const isFile = async (target: string): Promise<boolean> => {
  try {
    const stats = await lstat(target);
    return stats.isFile();
  } catch {
    return false;
  }
};

const listDirNames = async (root: string): Promise<string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

import { lstat, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertPathWithin, PathFenceError } from '@stack/shared';

import {
  discoverClaudeMemory,
  type ClaudeMemoryDiscoveryOptions,
} from '../claude-adapter.js';
import type { DiscoveredMemoryItem, ManifestItem } from '../domain.js';
import { hashBytes } from '../store.js';
import { atomicWriteFile } from '../remote/secure-file.js';
import { encodeClaudeProjectKey } from '../project-identity.js';
import { namespaceOf, validateCanonicalPath } from './paths.js';

export type BoundProject = {
  projectId: string;
  dir: string;
  gitRemote?: string;
};

export type NativeRoots = {
  projectDirExists: boolean;
  notesRootExists: boolean;
};

const isDir = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/** Whether `candidate` is a directory, WITHOUT following a symlink AT `candidate`
 * itself (an lstat, not a stat) — matching `discoverClaudeMemory`'s own
 * `listDirNames` (`readdir(withFileTypes)` + `entry.isDirectory()`, which reports
 * `false` for a symlinked entry regardless of what it points to). */
const isDirNoSymlink = async (candidate: string): Promise<boolean> => {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/** Whether this project's native roots exist on THIS machine — the mass-delete
 * guard's existence check (spec section 6): a missing root means "not
 * materialized here", never "everything in it was deleted".
 *
 * `notesRootExists` checks the `projects/<key>` SEGMENT ITSELF with
 * `isDirNoSymlink` first — this is exactly the entry `listDirNames` enumerates
 * when scanning, and a plain `lstat` on the full `.../memory` path would still
 * silently traverse THROUGH a symlinked `<key>` segment to reach it (lstat only
 * refuses to follow the FINAL path component, not intermediate ones). If this
 * check and the scan's own enumeration disagreed about whether a symlinked key
 * folder "exists", every note under it would be planned as deleted instead of
 * "not materialized here" the moment the key folder happened to be a symlink.
 * Once the key folder itself is confirmed to be a real (non-symlink) directory,
 * the `memory` subdirectory below it is checked with the ordinary `isDir`
 * (following any symlinks deeper is fine — `listDirNames` never looks past the
 * `<key>` entry itself). `project.dir` keeps the ordinary `isDir` check — a
 * user's own project checkout may legitimately be a symlink by the user's own
 * deliberate setup, and nothing in discovery treats THAT specially. */
export const nativeRootsExist = async (
  project: BoundProject,
  claudeHome: string = path.join(os.homedir(), '.claude'),
): Promise<NativeRoots> => {
  const keyDir = path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(path.resolve(project.dir)),
  );
  const keyFolderIsRealDir = await isDirNoSymlink(keyDir);
  return {
    projectDirExists: await isDir(project.dir),
    notesRootExists:
      keyFolderIsRealDir && (await isDir(path.join(keyDir, 'memory'))),
  };
};

export type NativeDoc = {
  canonicalPath: string;
  contentHash: string;
  bytes: Uint8Array;
};
export type SourceConflict = { canonicalPath: string };
export type ScanResult = {
  docs: NativeDoc[];
  sourceConflicts: SourceConflict[];
};

export type MaterializeOp =
  | { kind: 'write'; canonicalPath: string; bytes: Uint8Array }
  | { kind: 'delete'; canonicalPath: string };
export type WriteResult = { written: string[]; deleted: string[] };

/**
 * Refuse a narrowed owned root whose path, from `anchor` down to `root`, passes
 * through a symlinked directory segment. `assertPathWithin` itself realpath-
 * canonicalizes `root`, so a symlinked root (or an ancestor of it) would silently
 * redirect the fence to wherever that symlink points — this check closes that gap.
 * A segment that does not exist yet (nothing created there so far) is not a
 * symlink and is safe to pass through.
 */
const assertRootHasNoSymlinkSegments = async (
  anchor: string,
  root: string,
): Promise<void> => {
  const relative = path.relative(anchor, root);
  const segments = relative
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  let current = anchor;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new PathFenceError(); // same error type assertPathWithin itself throws
  }
};

/** Maps one discovered Claude item to its canonical path, or null if out of scope
 * (global items — `user-instructions` and global `agent-memory` — stay in the v1
 * store per spec section 3). */
export const claudeCanonicalPathOf = (
  item: Pick<
    DiscoveredMemoryItem | ManifestItem,
    'scope' | 'kind' | 'restoreTarget'
  >,
): string | null => {
  if (item.scope !== 'project') return null;
  switch (item.kind) {
    case 'auto-memory':
      return validateCanonicalPath(`notes/${item.restoreTarget.relativePath}`);
    case 'agent-memory':
      // restoreTarget.relativePath is `.claude/agent-memory/<agent>/<rest>` for a
      // project-scoped item (see claude-adapter.ts section 4).
      return validateCanonicalPath(
        `agents/${item.restoreTarget.relativePath.replace(/^\.claude\/agent-memory\//, '')}`,
      );
    case 'project-private-instructions':
      return validateCanonicalPath('instructions/private.md');
    default:
      return null;
  }
};

/** The inverse mapping: a canonical path to the native Claude file for a bound
 * project. `claudeHome` is required to resolve `notes/` paths. */
export const claudeNativeTargetOf = (
  project: BoundProject,
  canonicalPath: string,
  claudeHome: string = path.join(os.homedir(), '.claude'),
): string => {
  const validated = validateCanonicalPath(canonicalPath);
  const namespace = namespaceOf(validated);
  if (!namespace)
    throw new Error(
      `No native Claude target for canonical path: ${canonicalPath}`,
    );
  const rest = validated.slice(namespace.length + 1);
  if (namespace === 'notes') {
    const key = encodeClaudeProjectKey(path.resolve(project.dir));
    return path.join(claudeHome, 'projects', key, 'memory', rest);
  }
  if (namespace === 'agents')
    return path.join(project.dir, '.claude', 'agent-memory', rest);
  if (namespace === 'instructions' && rest === 'private.md')
    return path.join(project.dir, 'CLAUDE.local.md');
  throw new Error(
    `No native Claude target for canonical path: ${canonicalPath}`,
  );
};

/**
 * Scan every Claude location that resolves to `project.projectId` — reusing
 * `discoverClaudeMemory`'s own moved-folder matching (gitRemote/isDirectory) — and
 * map each item onto a canonical path. When several matched folders disagree on
 * content at the same canonical path, that path is reported as a `SourceConflict`
 * and OMITTED from `docs` (fail closed, same rule as `reconcileNativeWithStagedMemory`).
 */
export const scanClaudeProject = async (
  project: BoundProject,
  options: ClaudeMemoryDiscoveryOptions & {
    resolveProjectId(item: DiscoveredMemoryItem): string | undefined;
  },
): Promise<ScanResult> => {
  const items = await discoverClaudeMemory(options);
  const matched = items.filter(
    (item) => options.resolveProjectId(item) === project.projectId,
  );

  const byPath = new Map<string, DiscoveredMemoryItem[]>();
  for (const item of matched) {
    const canonicalPath = claudeCanonicalPathOf(item);
    if (!canonicalPath) continue;
    const group = byPath.get(canonicalPath);
    if (group) group.push(item);
    else byPath.set(canonicalPath, [item]);
  }

  const docs: NativeDoc[] = [];
  const sourceConflicts: SourceConflict[] = [];
  for (const [canonicalPath, group] of byPath) {
    const hashes = new Set(group.map((item) => item.contentHash));
    if (hashes.size > 1) {
      sourceConflicts.push({ canonicalPath });
      continue;
    }
    const [chosen] = group;
    if (!chosen) continue;
    const bytes = await readFile(chosen.source.path);
    docs.push({ canonicalPath, contentHash: hashBytes(bytes), bytes });
  }
  return {
    docs,
    sourceConflicts: sourceConflicts.sort((a, b) =>
      a.canonicalPath < b.canonicalPath ? -1 : 1,
    ),
  };
};

/** Write/delete native Claude files for the CURRENT bound location only — never
 * to any historical/leftover folder. Caller (the pull/materialize orchestrator,
 * Task 10) is responsible for only passing ops the sync engine already approved. */
export const writeClaudeProject = async (
  project: BoundProject,
  ops: MaterializeOp[],
  claudeHome: string = path.join(os.homedir(), '.claude'),
): Promise<WriteResult> => {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const op of ops) {
    const target = claudeNativeTargetOf(project, op.canonicalPath, claudeHome);
    const namespace = namespaceOf(op.canonicalPath);
    // The owned root is narrowed to the SPECIFIC memory subdirectory per namespace
    // (not the whole project.dir / project key dir) so that assertPathWithin's
    // realpath-based containment check also catches a symlink planted at the first
    // path segment under that subdirectory (e.g. `.claude/agent-memory/<agent>`
    // pointing at `../../.git/hooks`) — such a symlink target would still resolve
    // "within project.dir" but does NOT resolve within this narrower root.
    // `instructions/` has no such nested, attacker-influenced segment (the target is
    // always exactly `project.dir/CLAUDE.local.md`), so it keeps `project.dir` as the
    // owned root; assertPathWithin already catches CLAUDE.local.md itself being a
    // symlink that escapes project.dir.
    const ownedRoot =
      namespace === 'notes'
        ? path.join(
            claudeHome,
            'projects',
            encodeClaudeProjectKey(path.resolve(project.dir)),
            'memory',
          )
        : namespace === 'agents'
          ? path.join(project.dir, '.claude', 'agent-memory')
          : project.dir;
    if (namespace === 'notes')
      await assertRootHasNoSymlinkSegments(claudeHome, ownedRoot);
    else if (namespace === 'agents')
      await assertRootHasNoSymlinkSegments(project.dir, ownedRoot);
    await assertPathWithin({
      ownedRoot,
      proposedPath: target,
      allowRoot: true,
    });
    if (op.kind === 'write') {
      await atomicWriteFile(target, op.bytes);
      written.push(op.canonicalPath);
    } else {
      await rm(target, { force: true });
      deleted.push(op.canonicalPath);
    }
  }
  return { written, deleted };
};

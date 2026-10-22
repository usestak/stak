import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertPathWithin } from '@stack/shared';

import {
  discoverClaudeMemory,
  type ClaudeMemoryDiscoveryOptions,
} from '../claude-adapter.js';
import type { DiscoveredMemoryItem } from '../domain.js';
import { hashBytes } from '../store.js';
import { atomicWriteFile } from '../remote/secure-file.js';
import { encodeClaudeProjectKey } from '../project-identity.js';
import { namespaceOf, validateCanonicalPath } from './paths.js';

export type BoundProject = { projectId: string; dir: string; gitRemote?: string };

export type NativeDoc = { canonicalPath: string; contentHash: string; bytes: Uint8Array };
export type SourceConflict = { canonicalPath: string };
export type ScanResult = { docs: NativeDoc[]; sourceConflicts: SourceConflict[] };

export type MaterializeOp =
  | { kind: 'write'; canonicalPath: string; bytes: Uint8Array }
  | { kind: 'delete'; canonicalPath: string };
export type WriteResult = { written: string[]; deleted: string[] };

/** Maps one discovered Claude item to its canonical path, or null if out of scope
 * (global items — `user-instructions` and global `agent-memory` — stay in the v1
 * store per spec section 3). */
export const claudeCanonicalPathOf = (item: DiscoveredMemoryItem): string | null => {
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
  const rest = validated.slice(namespace!.length + 1);
  if (namespace === 'notes') {
    const key = encodeClaudeProjectKey(path.resolve(project.dir));
    return path.join(claudeHome, 'projects', key, 'memory', rest);
  }
  if (namespace === 'agents') return path.join(project.dir, '.claude', 'agent-memory', rest);
  if (namespace === 'instructions' && rest === 'private.md')
    return path.join(project.dir, 'CLAUDE.local.md');
  throw new Error(`No native Claude target for canonical path: ${canonicalPath}`);
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
  const matched = items.filter((item) => options.resolveProjectId(item) === project.projectId);

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
    const chosen = group[0]!;
    const bytes = await readFile(chosen.source.path);
    docs.push({ canonicalPath, contentHash: hashBytes(bytes), bytes });
  }
  return {
    docs,
    sourceConflicts: sourceConflicts.sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : 1)),
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
    const ownedRoot =
      namespace === 'notes'
        ? path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(project.dir)))
        : project.dir;
    await assertPathWithin({ ownedRoot, proposedPath: target, allowRoot: true });
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

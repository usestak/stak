import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertPathWithin } from '@stack/shared';

import type { ManifestItem, ProjectIdentity } from './domain.js';
import type { ClaudeProjectInput } from './claude-adapter.js';
import {
  canonicalGitIdentity,
  encodeClaudeProjectKey,
  projectIdentityKey,
  projectIdentityMatches,
} from './project-identity.js';
import { hashBytes, readMemoryManifest, readMemoryObject } from './store.js';

export type RestoreStatus =
  | 'identical' // target exists with the same content — no-op
  | 'conflict' // target exists with different content — refused (V0 never merges)
  | 'restorable' // target absent — may be restored on apply
  | 'project-not-found' // project item whose project is not on this machine
  | 'restored'
  | 'skipped';

export type RestoreItemResult = {
  logicalId: string;
  kind: ManifestItem['kind'];
  scope: ManifestItem['scope'];
  status: RestoreStatus;
  project?: ProjectIdentity; // portable identity, for unique-project aggregation
  targetPath?: string; // machine-local; verbose/JSON only
  reason?: string;
};

/** Unique project identities among project-scoped items (files never counted as projects). */
export const countProjects = (items: RestoreItemResult[]): number =>
  new Set(
    items.flatMap((item) =>
      item.scope === 'project' && item.project
        ? [projectIdentityKey(item.project)]
        : [],
    ),
  ).size;

export type RestorePlan = {
  provider: 'claude';
  files: number;
  projects: number;
  items: RestoreItemResult[];
};

export type RestoreOptions = {
  stackHome: string;
  claudeHome?: string;
  projects?: ClaudeProjectInput[];
};

type ResolvedProject = { dir: string; identity: ProjectIdentity };

const resolveProjects = (projects: ClaudeProjectInput[]): ResolvedProject[] =>
  projects.map((project) => {
    const dir = path.resolve(project.dir);
    return {
      dir,
      identity:
        canonicalGitIdentity(project.gitRemote) ??
        ({ kind: 'local', vendorKey: encodeClaudeProjectKey(dir) } as const),
    };
  });

const findProject = (
  identity: ProjectIdentity | undefined,
  resolved: ResolvedProject[],
): ResolvedProject | null => {
  if (!identity) return null;
  return (
    resolved.find((project) =>
      projectIdentityMatches(project.identity, identity),
    ) ?? null
  );
};

/** Resolve a portable restore target to a fenced absolute path, or a reason it can't be. */
const resolveTargetPath = async (
  item: ManifestItem,
  claudeHome: string,
  resolved: ResolvedProject[],
): Promise<{ targetPath: string } | { reason: string }> => {
  const target = item.restoreTarget;
  if (target.base === 'claude-home') {
    const abs = path.join(claudeHome, target.relativePath);
    await assertPathWithin({ ownedRoot: claudeHome, proposedPath: abs });
    return { targetPath: abs };
  }
  const project = findProject(item.project, resolved);
  if (!project) return { reason: 'Project not found on this machine.' };
  if (target.base === 'project') {
    const abs = path.join(project.dir, target.relativePath);
    await assertPathWithin({ ownedRoot: project.dir, proposedPath: abs });
    return { targetPath: abs };
  }
  // claude-project-memory: recompute the vendor key for THIS machine's project.
  const memoryRoot = path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(project.dir),
    'memory',
  );
  const abs = path.join(memoryRoot, target.relativePath);
  await assertPathWithin({ ownedRoot: memoryRoot, proposedPath: abs });
  return { targetPath: abs };
};

const currentHash = async (target: string): Promise<string | null> => {
  try {
    const stats = await lstat(target);
    if (!stats.isFile()) return null;
    return hashBytes(await readFile(target));
  } catch {
    return null;
  }
};

const classify = async (
  item: ManifestItem,
  claudeHome: string,
  resolved: ResolvedProject[],
): Promise<RestoreItemResult> => {
  const base = {
    logicalId: item.logicalId,
    kind: item.kind,
    scope: item.scope,
    ...(item.project ? { project: item.project } : {}),
  };
  const resolvedTarget = await resolveTargetPath(item, claudeHome, resolved);
  if ('reason' in resolvedTarget)
    return {
      ...base,
      status: 'project-not-found',
      reason: resolvedTarget.reason,
    };
  const existing = await currentHash(resolvedTarget.targetPath);
  const status: RestoreStatus =
    existing === null
      ? 'restorable'
      : existing === item.contentHash
        ? 'identical'
        : 'conflict';
  return { ...base, status, targetPath: resolvedTarget.targetPath };
};

const summarize = (
  items: RestoreItemResult[],
): { files: number; projects: number } => ({
  files: items.length,
  // Unique project identities, NOT one-per-file.
  projects: countProjects(items),
});

/** Preview a restore. Pure: reads the manifest and inspects targets, writes nothing. */
export const planMemoryRestore = async (
  options: RestoreOptions,
): Promise<RestorePlan> => {
  const claudeHome = path.resolve(
    options.claudeHome ?? path.join(os.homedir(), '.claude'),
  );
  const resolved = resolveProjects(options.projects ?? []);
  const manifest = await readMemoryManifest(options.stackHome);
  const items = manifest?.items ?? [];
  const results = [];
  for (const item of items)
    results.push(await classify(item, claudeHome, resolved));
  return { provider: 'claude', ...summarize(results), items: results };
};

const atomicWrite = async (target: string, bytes: Uint8Array) => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * Apply a restore. Only writes to ABSENT targets (`restorable`); identical
 * targets are no-ops, conflicts and unresolved projects are reported and skipped.
 * Never overwrites differing existing memory, never merges. Each written file is
 * verified against its expected hash.
 */
export const runMemoryRestore = async (
  options: RestoreOptions & { apply: boolean },
): Promise<RestorePlan> => {
  const plan = await planMemoryRestore(options);
  if (!options.apply) return plan;
  const applied: RestoreItemResult[] = [];
  const manifest = await readMemoryManifest(options.stackHome);
  const byId = new Map(
    (manifest?.items ?? []).map((item) => [item.logicalId, item]),
  );
  for (const result of plan.items) {
    if (result.status !== 'restorable' || !result.targetPath) {
      applied.push(result);
      continue;
    }
    // Re-check at apply time: never clobber a target that appeared meanwhile.
    if ((await currentHash(result.targetPath)) !== null) {
      applied.push({ ...result, status: 'conflict' });
      continue;
    }
    const item = byId.get(result.logicalId);
    if (!item) {
      applied.push({ ...result, status: 'skipped' });
      continue;
    }
    const bytes = await readMemoryObject({
      stackHome: options.stackHome,
      contentHash: item.contentHash,
    });
    await atomicWrite(result.targetPath, bytes);
    if (hashBytes(await readFile(result.targetPath)) !== item.contentHash)
      applied.push({
        ...result,
        status: 'skipped',
        reason: 'verification failed',
      });
    else applied.push({ ...result, status: 'restored' });
  }
  return { ...plan, items: applied };
};

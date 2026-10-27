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
import {
  bindingFor,
  emptyRegistry,
  resolveProjectForIdentity,
  type LocalRegistry,
} from './project/registry.js';
import { hashBytes, readMemoryManifest, readMemoryObject } from './store.js';

export type RestoreStatus =
  | 'identical' // target exists with the same content — no-op
  | 'conflict' // target exists with different content — refused (V0 never merges)
  | 'restorable' // target absent — may be restored on apply
  | 'project-not-found' // project item whose project is not available on this machine
  | 'identity-conflict' // strong identity claimed by >1 logical project — refuse
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
  /** Machine-local project registry (Project IDs + bindings). Defaults to empty. */
  registry?: LocalRegistry;
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

type DirResolution =
  { dir: string } | { unresolved: 'not-found' | 'identity-conflict' };

/**
 * Resolve a project identity to an authorized local destination directory (Phase 15B):
 *
 *  1. If the registry shows the identity's strong claim belongs to more than one
 *     logical project → identity-conflict; refuse (never silently merge).
 *  2. A GIT identity may auto-match a live candidate directory by canonical remote —
 *     path-independent, the behavior proven by the Atlas dogfood.
 *  3. If this identity's claim is reconciled (via the registry) to a stable logical
 *     Project that is ALSO claimed by a live Git checkout on this machine right now,
 *     restore follows that Project — e.g. a project first captured under a local path,
 *     later strengthened to a Git remote (`syncRegistryForBackup`'s identity-
 *     strengthening, which calls `adoptReconciledProjectId`), still has its historical
 *     local-locator Memory items. This matches on PROVEN PROJECT IDENTITY (the SAME
 *     reconciled Project ID), never on path or name similarity — an unrelated local
 *     Project that merely happens to also be unresolved never qualifies.
 *  4. Otherwise, only an explicit machine-local BINDING authorizes a destination.
 *
 * A legacy `local:` identity is NEVER matched by re-encoding a directory's path to its
 * vendor key: path reuse must not resurrect unrelated Memory. An identity that was
 * never reconciled to an available Git Project resolves only through an explicit
 * binding (`stack project map`).
 */
const resolveProjectDir = (
  identity: ProjectIdentity | undefined,
  registry: LocalRegistry,
  resolved: ResolvedProject[],
): DirResolution => {
  if (!identity) return { unresolved: 'not-found' };
  const reg = resolveProjectForIdentity(registry, identity);
  if (reg.status === 'conflict') return { unresolved: 'identity-conflict' };

  if (identity.kind === 'git') {
    const candidate = resolved.find(
      (project) =>
        project.identity.kind === 'git' &&
        projectIdentityMatches(project.identity, identity),
    );
    if (candidate) return { dir: candidate.dir };
  }

  if (reg.status === 'resolved') {
    const liveGitMatch = resolved.find((project) => {
      if (project.identity.kind !== 'git') return false;
      const candidateReg = resolveProjectForIdentity(
        registry,
        project.identity,
      );
      return (
        candidateReg.status === 'resolved' &&
        candidateReg.projectId === reg.projectId
      );
    });
    if (liveGitMatch) return { dir: liveGitMatch.dir };

    const binding = bindingFor(registry, reg.projectId);
    if (binding) return { dir: path.resolve(binding.dir) };
  }
  return { unresolved: 'not-found' };
};

/** Resolve a portable restore target to a fenced absolute path, or why it can't be. */
const resolveTargetPath = async (
  item: ManifestItem,
  claudeHome: string,
  registry: LocalRegistry,
  resolved: ResolvedProject[],
): Promise<
  | { targetPath: string }
  | { status: 'project-not-found' | 'identity-conflict'; reason: string }
> => {
  const target = item.restoreTarget;
  if (target.base === 'claude-home') {
    const abs = path.join(claudeHome, target.relativePath);
    await assertPathWithin({ ownedRoot: claudeHome, proposedPath: abs });
    return { targetPath: abs };
  }
  const dir = resolveProjectDir(item.project, registry, resolved);
  if ('unresolved' in dir)
    return dir.unresolved === 'identity-conflict'
      ? {
          status: 'identity-conflict',
          reason:
            'This project’s identity is claimed by more than one project; map it explicitly.',
        }
      : {
          status: 'project-not-found',
          reason: 'Project is not available on this machine.',
        };
  if (target.base === 'project') {
    const abs = path.join(dir.dir, target.relativePath);
    await assertPathWithin({ ownedRoot: dir.dir, proposedPath: abs });
    return { targetPath: abs };
  }
  // claude-project-memory: recompute the vendor key for THIS machine's directory.
  const memoryRoot = path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(dir.dir),
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
  registry: LocalRegistry,
  resolved: ResolvedProject[],
): Promise<RestoreItemResult> => {
  const base = {
    logicalId: item.logicalId,
    kind: item.kind,
    scope: item.scope,
    ...(item.project ? { project: item.project } : {}),
  };
  const resolvedTarget = await resolveTargetPath(
    item,
    claudeHome,
    registry,
    resolved,
  );
  if ('status' in resolvedTarget)
    return {
      ...base,
      status: resolvedTarget.status,
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
  const registry = options.registry ?? emptyRegistry();
  const manifest = await readMemoryManifest(options.stackHome);
  const items = manifest?.items ?? [];
  const results = [];
  for (const item of items)
    results.push(await classify(item, claudeHome, registry, resolved));
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
    const item = byId.get(result.logicalId);
    // Re-check at apply time: a target that appeared meanwhile (including a different
    // manifest item restored to the SAME target earlier in this very apply — e.g. a
    // legacy-locator and a canonical-locator item reconciled to the same Project) is
    // dedupe-safe when its content already matches this item's own expected hash;
    // otherwise it is a genuine conflict and is never clobbered.
    const existingHash = await currentHash(result.targetPath);
    if (existingHash !== null) {
      applied.push({
        ...result,
        status:
          item && existingHash === item.contentHash ? 'identical' : 'conflict',
      });
      continue;
    }
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

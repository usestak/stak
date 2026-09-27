/**
 * CLI operations for the logical-project registry (Phase 15B):
 *   - `listProjects`  → read-only view for `stack project`
 *   - `mapProject`    → explicit machine-local binding for `stack project map`
 *
 * Pure and injectable (no direct git/process access) so the behavior is testable
 * without the filesystem network. `mapProject` writes ONLY a machine-local binding;
 * it never turns a filesystem path into a portable identity and never silently merges
 * two logical projects.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudeProjectInput } from '@stack/memory';
import {
  canonicalGitIdentity,
  bindingFor,
  gitClaimOf,
  readLocalRegistry,
  recordFor,
  resolveProjectForIdentity,
  registryConflicts,
  setBinding,
  writeLocalRegistry,
  readMemoryManifest,
  type LocalRegistry,
  type PortableProjectRecord,
} from '@stack/memory';

export type ProjectIdentityView =
  { kind: 'git'; canonical: string } | { kind: 'local' };

export type ProjectListRow = {
  projectId: string;
  identity: ProjectIdentityView;
  binding: string | null;
  files: number;
  availability: 'present' | 'unavailable';
  conflict: boolean;
};

const identityView = (record: PortableProjectRecord): ProjectIdentityView => {
  const git = gitClaimOf(record);
  return git ? { kind: 'git', canonical: git.canonical } : { kind: 'local' };
};

/** Canonical Git identities of the local candidate directories. */
const candidateGitCanonicals = (
  projects: ClaudeProjectInput[],
): Set<string> => {
  const set = new Set<string>();
  for (const project of projects) {
    const git = canonicalGitIdentity(project.gitRemote);
    if (git) set.add(git.canonical.toLowerCase());
  }
  return set;
};

/** Count manifest files attributable to each logical project. */
const filesByProject = async (
  stackHome: string,
  registry: LocalRegistry,
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const manifest = await readMemoryManifest(stackHome);
  for (const item of manifest?.items ?? []) {
    if (item.scope !== 'project' || !item.project) continue;
    const resolution = resolveProjectForIdentity(registry, item.project);
    if (resolution.status !== 'resolved') continue;
    counts.set(
      resolution.projectId,
      (counts.get(resolution.projectId) ?? 0) + 1,
    );
  }
  return counts;
};

export const listProjects = async (deps: {
  stackHome: string;
  projects?: ClaudeProjectInput[];
}): Promise<ProjectListRow[]> => {
  const registry = await readLocalRegistry(deps.stackHome);
  const counts = await filesByProject(deps.stackHome, registry);
  const candidateGit = candidateGitCanonicals(deps.projects ?? []);
  const conflicted = new Set(
    registryConflicts(registry).flatMap((conflict) => conflict.projectIds),
  );
  return registry.projects
    .map((record) => {
      const view = identityView(record);
      const binding = bindingFor(registry, record.projectId);
      const gitAutoMatch =
        view.kind === 'git' && candidateGit.has(view.canonical.toLowerCase());
      return {
        projectId: record.projectId,
        identity: view,
        binding: binding ? binding.dir : null,
        files: counts.get(record.projectId) ?? 0,
        availability: (binding || gitAutoMatch ? 'present' : 'unavailable') as
          'present' | 'unavailable',
        conflict: conflicted.has(record.projectId),
      };
    })
    .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
};

/* -------------------------------------------------------------------------- */
/* map                                                                          */
/* -------------------------------------------------------------------------- */

export type MapProjectResult =
  | { status: 'mapped'; projectId: string; dir: string }
  | { status: 'project-not-found' }
  | { status: 'ambiguous-selector'; matches: string[] }
  | { status: 'not-a-directory' }
  | { status: 'git-conflict'; projectGit: string; dirGit: string }
  | { status: 'identity-conflict'; projectId: string };

/** Resolve a selector (full Project ID or a unique prefix) to one record. */
const resolveSelector = (
  registry: LocalRegistry,
  selector: string,
):
  | { record: PortableProjectRecord }
  | { error: 'project-not-found' }
  | { error: 'ambiguous-selector'; matches: string[] } => {
  const exact = recordFor(registry, selector);
  if (exact) return { record: exact };
  const matches = registry.projects.filter((record) =>
    record.projectId.startsWith(selector),
  );
  if (matches.length === 1)
    return { record: matches[0] as PortableProjectRecord };
  if (matches.length === 0) return { error: 'project-not-found' };
  return {
    error: 'ambiguous-selector',
    matches: matches.map((record) => record.projectId),
  };
};

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

export const mapProject = async (deps: {
  stackHome: string;
  selector: string;
  dir: string;
  gitOrigin: (dir: string) => Promise<string | undefined>;
  now?: () => Date;
  dirExists?: (dir: string) => Promise<boolean>;
}): Promise<MapProjectResult> => {
  const now = deps.now ?? (() => new Date());
  const exists = deps.dirExists ?? dirExists;
  const registry = await readLocalRegistry(deps.stackHome);
  const resolved = resolveSelector(registry, deps.selector);
  if ('error' in resolved)
    return resolved.error === 'project-not-found'
      ? { status: 'project-not-found' }
      : { status: 'ambiguous-selector', matches: resolved.matches };
  const record = resolved.record;
  const dir = path.resolve(deps.dir);
  if (!(await exists(dir))) return { status: 'not-a-directory' };

  // Inspect the target directory's own strong Git identity, if any.
  const targetGit = canonicalGitIdentity(await deps.gitOrigin(dir));
  const recordGit = gitClaimOf(record);

  // A repository transfer/rename is later work: refuse a map where the directory's
  // strong identity contradicts the logical project's known strong identity.
  if (
    targetGit &&
    recordGit &&
    targetGit.canonical.toLowerCase() !== recordGit.canonical.toLowerCase()
  )
    return {
      status: 'git-conflict',
      projectGit: recordGit.canonical,
      dirGit: targetGit.canonical,
    };

  // Refuse if the directory's strong identity already belongs to a DIFFERENT project.
  if (targetGit) {
    const owner = registry.projects.find(
      (other) =>
        other.projectId !== record.projectId &&
        gitClaimOf(other)?.canonical.toLowerCase() ===
          targetGit.canonical.toLowerCase(),
    );
    if (owner)
      return { status: 'identity-conflict', projectId: owner.projectId };
  }

  // Machine-local binding ONLY. The path is not promoted to a portable identity.
  const updated = setBinding(registry, {
    projectId: record.projectId,
    dir,
    boundAt: now().toISOString(),
    provenance: 'user-map',
  });
  await writeLocalRegistry(deps.stackHome, updated);
  return { status: 'mapped', projectId: record.projectId, dir };
};

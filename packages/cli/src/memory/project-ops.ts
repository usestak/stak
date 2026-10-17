/**
 * CLI operations for the logical-project registry (Phase 15B):
 *   - `listProjects`  → read-only view for `stak project`
 *   - `mapProject`    → explicit machine-local binding for `stak project map`
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
  lifecycleOf,
  nameHintFor,
  projectIdentityKey,
  readLocalRegistry,
  recordFor,
  resolveProjectForIdentity,
  registryConflicts,
  setBinding,
  setExplicitNameHint,
  setLifecycle,
  writeLocalRegistry,
  readMemoryManifest,
  type LocalRegistry,
  type PortableProjectRecord,
  type ProjectLifecycle,
} from '@stack/memory';

export type ProjectIdentityView =
  { kind: 'git'; canonical: string } | { kind: 'local' };

/**
 * Informational-only provenance for a recovered legacy project, correlated LOCALLY
 * from the recovered private Memory manifest so a human can tell two "local project"
 * rows apart. It is NOT identity authority: it never authorizes a restore, never
 * enters the portable registry/bundle/public artifacts, and a live directory at this
 * historical reference is still not auto-resolved (path reuse stays unsafe). It is
 * `null` for Git-backed projects and when no legacy reference is available.
 */
export type RecoveryReference = { kind: 'legacy-local'; value: string };

export type ProjectListRow = {
  projectId: string;
  identity: ProjectIdentityView;
  // Lifecycle (active | archived) is INDEPENDENT of availability (Phase 15C).
  lifecycle: 'active' | 'archived';
  binding: string | null;
  files: number;
  availability: 'present' | 'unavailable';
  conflict: boolean;
  recoveryReference: RecoveryReference | null;
  // Machine-local discovery-time basename hint (never a full path) — see
  // `@stack/memory`'s `nameHintFor`. Null when no hint has ever been captured on this
  // machine. Takes precedence over the binding's basename (see `checkin.ts`'s
  // `projectSyncPayloadFrom` and `project.ts`'s `identityLabel`).
  discoveredName: string | null;
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

/**
 * Correlate each logical project with LOCAL manifest facts: its file count and, for
 * legacy projects, the historical recovery reference (`local:<vendorKey>`) read from
 * the locally recovered Memory manifest. The reference is computed at list time and
 * never persisted; it is informational provenance, not identity authority.
 */
const manifestFacts = async (
  stackHome: string,
  registry: LocalRegistry,
): Promise<{
  counts: Map<string, number>;
  references: Map<string, string>;
}> => {
  const counts = new Map<string, number>();
  const references = new Map<string, string>();
  const manifest = await readMemoryManifest(stackHome);
  for (const item of manifest?.items ?? []) {
    if (item.scope !== 'project' || !item.project) continue;
    const resolution = resolveProjectForIdentity(registry, item.project);
    if (resolution.status !== 'resolved') continue;
    counts.set(
      resolution.projectId,
      (counts.get(resolution.projectId) ?? 0) + 1,
    );
    // Only legacy (local) identities carry a distinguishing recovery reference;
    // Git-backed projects already show their canonical remote as identity.
    if (item.project.kind === 'local' && !references.has(resolution.projectId))
      references.set(resolution.projectId, projectIdentityKey(item.project));
  }
  return { counts, references };
};

export const listProjects = async (deps: {
  stackHome: string;
  projects?: ClaudeProjectInput[];
}): Promise<ProjectListRow[]> => {
  const registry = await readLocalRegistry(deps.stackHome);
  const { counts, references } = await manifestFacts(deps.stackHome, registry);
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
      const reference =
        view.kind === 'local' ? references.get(record.projectId) : undefined;
      return {
        projectId: record.projectId,
        identity: view,
        lifecycle: lifecycleOf(record),
        binding: binding ? binding.dir : null,
        files: counts.get(record.projectId) ?? 0,
        availability: (binding || gitAutoMatch ? 'present' : 'unavailable') as
          'present' | 'unavailable',
        conflict: conflicted.has(record.projectId),
        recoveryReference: reference
          ? ({ kind: 'legacy-local', value: reference } as const)
          : null,
        discoveredName: nameHintFor(registry, record.projectId) ?? null,
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

/* -------------------------------------------------------------------------- */
/* lifecycle (archive / unarchive) — Phase 15C                                 */
/* -------------------------------------------------------------------------- */

export type SetLifecycleResult =
  | {
      status: 'ok';
      projectId: string;
      lifecycle: ProjectLifecycle;
      changed: boolean;
    }
  | { status: 'project-not-found' }
  | { status: 'ambiguous-selector'; matches: string[] };

/**
 * Set a project's lifecycle (machine-local write). Idempotent: setting the value it
 * already has is a safe no-op (`changed: false`). Never mints, never deletes, never
 * touches Memory, bindings, or identity claims. The lifecycle change becomes portable
 * only after the next `stak memory backup`.
 */
export const setProjectLifecycle = async (deps: {
  stackHome: string;
  selector: string;
  lifecycle: ProjectLifecycle;
}): Promise<SetLifecycleResult> => {
  const registry = await readLocalRegistry(deps.stackHome);
  const resolved = resolveSelector(registry, deps.selector);
  if ('error' in resolved)
    return resolved.error === 'project-not-found'
      ? { status: 'project-not-found' }
      : { status: 'ambiguous-selector', matches: resolved.matches };
  const record = resolved.record;
  const changed = lifecycleOf(record) !== deps.lifecycle;
  if (changed)
    await writeLocalRegistry(
      deps.stackHome,
      setLifecycle(registry, record.projectId, deps.lifecycle),
    );
  return {
    status: 'ok',
    projectId: record.projectId,
    lifecycle: deps.lifecycle,
    changed,
  };
};

/* -------------------------------------------------------------------------- */
/* name (explicit display name)                                                */
/* -------------------------------------------------------------------------- */

export type SetProjectNameResult =
  | { status: 'ok'; projectId: string; name: string }
  | { status: 'project-not-found' }
  | { status: 'ambiguous-selector'; matches: string[] }
  | { status: 'git-identity'; canonical: string }
  | { status: 'invalid-name'; reason: 'empty' | 'too-long' | 'path-like' };

const MAX_PROJECT_NAME_LENGTH = 200;

/**
 * Validate a user-supplied display name is safe to store and sync: never a path (no
 * separators — this also keeps it from ever being misread as a Git canonical by the
 * web's `name.includes('/')` shape check), never empty, and bounded in length (matches
 * `projectNameHintSchema`). This is presentation input validation, not a basename
 * extractor — unlike `safeDirectoryBasename`, it never looks at a real directory.
 */
const invalidProjectNameReason = (
  name: string,
): 'empty' | 'too-long' | 'path-like' | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return 'too-long';
  if (/[\\/]/.test(trimmed)) return 'path-like';
  return null;
};

/**
 * Set a Project's EXPLICIT display name (`stak project name <project> <name>`).
 * Machine-local write only, synced to Cloud through the existing `syncProjects` path on
 * the next check-in — exactly the mechanism discovery-time names already use. Never
 * touches `projectId`, claims, bindings, or lifecycle: displayName is presentation
 * metadata only, never identity. Refused for a Git-backed Project — its name is its
 * canonical Git identity and is not user-renamable. Always targets one explicitly
 * selected Project; there is no bulk/implicit rename path, so an archived Project is
 * only ever renamed when the caller explicitly names it.
 */
export const setProjectDisplayName = async (deps: {
  stackHome: string;
  selector: string;
  name: string;
}): Promise<SetProjectNameResult> => {
  const invalid = invalidProjectNameReason(deps.name);
  if (invalid) return { status: 'invalid-name', reason: invalid };

  const registry = await readLocalRegistry(deps.stackHome);
  const resolved = resolveSelector(registry, deps.selector);
  if ('error' in resolved)
    return resolved.error === 'project-not-found'
      ? { status: 'project-not-found' }
      : { status: 'ambiguous-selector', matches: resolved.matches };
  const record = resolved.record;
  const git = gitClaimOf(record);
  if (git) return { status: 'git-identity', canonical: git.canonical };

  const name = deps.name.trim();
  await writeLocalRegistry(
    deps.stackHome,
    setExplicitNameHint(registry, record.projectId, name),
  );
  return { status: 'ok', projectId: record.projectId, name };
};

/**
 * Seed a Cloud-known display name onto its recovered logical Project, so the name is
 * visible on a fresh machine BEFORE any local directory is mapped (`stak memory
 * recover`). Cloud's `name` column is the only source read here — never the Memory
 * bundle (keeps bundle content privacy-pure) and never a local path/basename. Only
 * applies to a Project this registry actually has a record for (i.e. one `recover`
 * just reconciled); skips a Git-backed Project (its name is already its canonical
 * identity, never overridable) and any entry with no name. Marked `explicit` so a
 * later discovery-time basename on THIS machine can never silently clobber the
 * Cloud-known name — the whole point of carrying it across the recovery. Idempotent,
 * never touches claims/bindings/lifecycle, never mints or changes a `projectId`.
 */
export const applyRecoveredProjectNames = async (deps: {
  stackHome: string;
  names: { projectId: string; name?: string | undefined }[];
}): Promise<void> => {
  let registry = await readLocalRegistry(deps.stackHome);
  let changed = false;
  for (const { projectId, name } of deps.names) {
    if (!name) continue;
    const record = recordFor(registry, projectId);
    if (!record) continue; // not a Project this machine's registry knows about
    if (gitClaimOf(record)) continue; // Git identity already names itself
    registry = setExplicitNameHint(registry, projectId, name);
    changed = true;
  }
  if (changed) await writeLocalRegistry(deps.stackHome, registry);
};

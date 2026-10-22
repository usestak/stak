import path from 'node:path';

import {
  applyImportActions,
  bindingFor,
  discoverClaudeMemory,
  encodeClaudeProjectKey,
  migrateLocalStore,
  normalizeVendorKey,
  planProjectSync,
  readLocalRegistry,
  reconstructProjectDir,
  resolveOrMintProject,
  resolveProjectForIdentity,
  scanClaudeProject,
  writeLocalRegistry,
  projectIdentityKey,
  type ClaudeProjectInput,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
  type ProjectIdentity,
  type ScanResult,
} from '@stack/memory';

import { resolveCanonicalProjectId } from './canonical-identity.js';

export type CanonicalProjectSummary = {
  projectId: string;
  imported: string[];
  /** Planned-but-not-yet-applied `import-edit`/`import-delete` actions — always `0`
   * for `stageCanonicalMemory` (staging resolves everything pending), the count of
   * what `stak add .` WOULD import for `canonicalMemoryStatus` (never applies it). */
  pending: number;
  conflicts: { path: string; reason: string }[];
  sourceConflicts: string[];
  guardedPaths: string[];
};

/**
 * Discovery options for canonical Memory sync — the SAME native-discovery inputs v1
 * staging already uses (`program.ts`'s `memoryDiscoveryOptions()`), so canonical
 * Memory recognizes exactly the projects v1 would have: the current project is "on
 * this machine" per spec §4.5 the moment STAK can find its folder, with no separate
 * mapping step required for the normal case.
 */
export type CanonicalDiscoveryOptions = {
  claudeHome?: string;
  /** Candidate local project directories (cwd + siblings, each with any resolvable
   * Git origin) — `resolveMemoryProjects`'s output. Used both to re-derive a strong
   * Git identity for an unmatched vendor key (passed straight through to discovery)
   * and, here, to locate a project's CURRENT directory by matching its vendor key. */
  projects?: ClaudeProjectInput[];
  gitRemoteOf?: (dir: string) => Promise<string | undefined>;
  isDirectory?: (candidate: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
};

/** The grouping/lookup key for one logical identity — git: its canonical remote
 * (already case-normalized on the host); local: its vendor key NORMALIZED for the
 * platform (Critical identity bug: Claude itself can produce a differently-cased
 * vendor key — e.g. a lowercase drive letter — for the SAME real, case-insensitive
 * win32 folder as `encodeClaudeProjectKey` independently computes; without
 * normalizing the GROUPING key too, these would split into two distinct identities
 * instead of being proven, by the filesystem's own case-insensitivity, to be one). */
const groupKeyOf = (identity: ProjectIdentity, platform: NodeJS.Platform): string =>
  identity.kind === 'git'
    ? projectIdentityKey(identity)
    : `local:${normalizeVendorKey(identity.vendorKey ?? 'unresolved', platform)}`;

type ProjectGroup = {
  /** A representative identity for this group — used only to MINT a fresh claim
   * (any one of this group's raw variants is an equally valid claim to register).
   * Resolving an EXISTING Project ID never relies on this single representative —
   * see `resolveKnownProjectId`, which checks every raw variant independently. */
  identity: ProjectIdentity;
  identityKey: string;
  /** Every distinct Claude vendor key discovered under this one logical identity —
   * present for BOTH local and git identities (every discovered item carries its
   * raw `source.vendorKey` regardless of how its identity resolved). More than one
   * exactly when: a relocated/re-cloned project's stale old folder is still
   * discovered alongside the current one, OR Claude produced a differently-cased
   * vendor key for the same case-insensitive folder. */
  vendorKeys: Set<string>;
};

/** Group every discovered project-scope item by its logical (Project) identity,
 * collecting all the distinct Claude vendor keys discovered under it. */
const groupProjectItems = (
  items: DiscoveredMemoryItem[],
  platform: NodeJS.Platform,
): ProjectGroup[] => {
  const groups = new Map<string, ProjectGroup>();
  for (const item of items) {
    if (item.scope !== 'project' || !item.project) continue;
    const identityKey = groupKeyOf(item.project, platform);
    let group = groups.get(identityKey);
    if (!group) {
      group = { identity: item.project, identityKey, vendorKeys: new Set() };
      groups.set(identityKey, group);
    }
    if (item.source.vendorKey) group.vendorKeys.add(item.source.vendorKey);
  }
  return [...groups.values()];
};

/** Dedupe candidate directories by their (normalized) encoded vendor key — a bound
 * dir that is ALSO present in the caller-supplied candidates must only ever be fed
 * into discovery once. When two candidates collide, keep whichever carries a
 * `gitRemote` (never drop a known Git origin in favor of a plain binding-derived
 * stand-in). */
const dedupeCandidates = (
  candidates: ClaudeProjectInput[],
  platform: NodeJS.Platform,
): ClaudeProjectInput[] => {
  const byKey = new Map<string, ClaudeProjectInput>();
  for (const candidate of candidates) {
    const key = normalizeVendorKey(encodeClaudeProjectKey(path.resolve(candidate.dir)), platform);
    const existing = byKey.get(key);
    if (!existing || (!existing.gitRemote && candidate.gitRemote)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
};

const findCandidateDir = (
  vendorKeys: Set<string>,
  candidates: ClaudeProjectInput[],
  platform: NodeJS.Platform,
): ClaudeProjectInput | undefined => {
  const targets = new Set([...vendorKeys].map((key) => normalizeVendorKey(key, platform)));
  for (const candidate of candidates) {
    const candidateKey = normalizeVendorKey(
      encodeClaudeProjectKey(path.resolve(candidate.dir)),
      platform,
    );
    if (targets.has(candidateKey)) return candidate;
  }
  return undefined;
};

const findReconstructedDir = async (
  vendorKeys: Set<string>,
  isDirectory: ((candidate: string) => Promise<boolean>) | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  if (!isDirectory) return undefined;
  for (const vendorKey of vendorKeys) {
    const dir = await reconstructProjectDir({ vendorKey, isDirectory, platform });
    if (dir) return dir;
  }
  return undefined;
};

/**
 * Determine a project's CURRENT directory (the write target), in priority order:
 *  (a) an explicit machine binding for this (already-resolved, READ-ONLY) Project ID
 *      (`stak project map`'s escape hatch for a project STAK can't otherwise locate);
 *  (b) a candidate directory (cwd/siblings) whose encoded vendor key matches;
 *  (c) an unambiguous reconstruction of the vendor key back to a real directory.
 * Returns `undefined` (never available on this machine) when none apply — the
 * project's canonical Memory is left untouched, per spec §4.5.
 */
const resolveProjectDir = async (
  group: ProjectGroup,
  knownProjectId: string | undefined,
  registry: LocalRegistry,
  candidates: ClaudeProjectInput[],
  options: {
    gitRemoteOf?: (dir: string) => Promise<string | undefined>;
    isDirectory?: (candidate: string) => Promise<boolean>;
    platform: NodeJS.Platform;
  },
): Promise<{ dir: string; gitRemote?: string } | undefined> => {
  if (knownProjectId) {
    const binding = bindingFor(registry, knownProjectId);
    if (binding) return { dir: binding.dir };
  }
  const candidate = findCandidateDir(group.vendorKeys, candidates, options.platform);
  if (candidate)
    return {
      dir: path.resolve(candidate.dir),
      ...(candidate.gitRemote ? { gitRemote: candidate.gitRemote } : {}),
    };
  const reconstructed = await findReconstructedDir(group.vendorKeys, options.isDirectory, options.platform);
  if (reconstructed) return { dir: reconstructed };
  return undefined;
};

type IdentityResolution = { projectId: string | undefined; conflict: boolean };

/**
 * Resolve a group's EXISTING Project ID, READ-ONLY (never mints — see
 * `enumerateSyncableProjects`, which mints only AFTER a write-target directory is
 * actually located):
 *
 *  1. A registry CLAIM — checked against EVERY raw vendor-key variant this group
 *     collected (Critical identity bug: a win32 case-differing vendor key for the
 *     SAME real folder must not be treated as a second identity). Exactly one
 *     distinct claimed Project ID resolves it; more than one is a genuine conflict
 *     (fail closed — never silently pick one); none falls through to (2).
 *  2. An explicit machine BINDING (`stak project map`) is user-proof that its
 *     directory belongs to a Project REGARDLESS of identity kind (Critical identity
 *     bug: a mapped Git checkout whose auto-memory resolves to a strong Git identity
 *     with no existing Git claim must still land on the bound Project, not mint a
 *     phantom second one) — compared via normalized vendor keys on both sides.
 *     Exactly one distinct bound Project ID resolves it; more than one is a
 *     conflict; none means "no existing Project ID" (not itself a conflict).
 */
const resolveKnownProjectId = (
  group: ProjectGroup,
  registry: LocalRegistry,
  platform: NodeJS.Platform,
): IdentityResolution => {
  const claimedIds = new Set<string>();
  let conflict = false;
  if (group.identity.kind === 'git') {
    const resolution = resolveProjectForIdentity(registry, group.identity);
    if (resolution.status === 'resolved') claimedIds.add(resolution.projectId);
    if (resolution.status === 'conflict') conflict = true;
  } else {
    for (const vendorKey of group.vendorKeys) {
      const resolution = resolveProjectForIdentity(registry, { kind: 'local', vendorKey });
      if (resolution.status === 'resolved') claimedIds.add(resolution.projectId);
      if (resolution.status === 'conflict') conflict = true;
    }
  }
  if (conflict || claimedIds.size > 1) return { projectId: undefined, conflict: true };
  if (claimedIds.size === 1) return { projectId: [...claimedIds][0] as string, conflict: false };

  const targets = new Set([...group.vendorKeys].map((key) => normalizeVendorKey(key, platform)));
  const boundIds = new Set<string>();
  for (const binding of registry.bindings) {
    const bindingKey = normalizeVendorKey(encodeClaudeProjectKey(path.resolve(binding.dir)), platform);
    if (targets.has(bindingKey)) boundIds.add(binding.projectId);
  }
  if (boundIds.size > 1) return { projectId: undefined, conflict: true };
  if (boundIds.size === 1) return { projectId: [...boundIds][0] as string, conflict: false };

  return { projectId: undefined, conflict: false };
};

type ResolvedProject = { projectId: string; dir: string; gitRemote?: string };

type EnumerationResult = {
  resolved: ResolvedProject[];
  registry: LocalRegistry;
  /** Locatable, non-conflicted project identities with no registered Project ID yet
   * (status mode only — staging mints and resolves them instead). */
  newProjectCount: number;
  /** Groups whose identity resolution was genuinely ambiguous (more than one
   * distinct existing Project ID claims or is bound to the same identity) — never
   * staged, regardless of mode; reported separately so they are never confused with
   * a genuinely new, unclaimed project. */
  conflictedCount: number;
  /** Every discovered item's group, mapped to the FINAL Project ID enumeration
   * decided for it (only for groups that got one — conflicted/pending groups are
   * absent) — fed into each project's own `scanClaudeProject`/`planProjectSync` call
   * so every item is attributed to EXACTLY the Project ID enumeration decided, never
   * re-derived independently (which could disagree, e.g. for a Git identity this
   * group's binding fallback resolved that `canonical-identity.ts`'s own resolver —
   * deliberately unmodified — has no equivalent rule for). */
  groupProjectIds: Map<string, string>;
};

/**
 * Enumerate every syncable project from LIVE native discovery (not just machine
 * bindings — see the Task 12 review: a never-mapped, ordinary project must still
 * sync, since `stak project map` is only the fallback for a project STAK can't
 * locate on its own).
 *
 * Per group: resolve any EXISTING Project ID read-only (`resolveKnownProjectId`),
 * THEN locate its directory, THEN — `mode: 'stage'` only, and only once a directory
 * was actually found — mint a fresh Project ID if neither step resolved one. `mode:
 * 'status'` never mints or writes anything; a locatable, unclaimed, non-conflicted
 * group is counted in `newProjectCount` instead of being added to `resolved`.
 */
const enumerateSyncableProjects = async (
  stackHome: string,
  options: CanonicalDiscoveryOptions,
  mode: 'status' | 'stage',
): Promise<EnumerationResult> => {
  const platform = options.platform ?? process.platform;
  let registry = await readLocalRegistry(stackHome);
  // A project's own native memory may be ENTIRELY project-local (`CLAUDE.local.md`,
  // `.claude/agent-memory/`) with no `claudeHome/projects/<vendorKey>/memory/`
  // auto-memory folder at all — `discoverClaudeMemory` only scans a project-local
  // location when that directory is in its `projects` candidate list. Every
  // currently-bound directory MUST be a candidate here too, or a bound project with
  // no auto-memory folder would never be (re)discovered by this enumeration pass at
  // all, even though its binding (priority (a)) already tells us exactly where it is.
  const candidates = dedupeCandidates(
    [...(options.projects ?? []), ...registry.bindings.map((binding) => ({ dir: binding.dir }))],
    platform,
  );
  const discovered = await discoverClaudeMemory({
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    projects: candidates,
    platform,
    ...(options.gitRemoteOf ? { gitRemoteOf: options.gitRemoteOf } : {}),
    ...(options.isDirectory ? { isDirectory: options.isDirectory } : {}),
  });
  const groups = groupProjectItems(discovered, platform);

  const resolved: ResolvedProject[] = [];
  const seen = new Set<string>();
  const groupProjectIds = new Map<string, string>();
  let newProjectCount = 0;
  let conflictedCount = 0;
  let mintedAny = false;

  for (const group of groups) {
    const known = resolveKnownProjectId(group, registry, platform);
    if (known.conflict) {
      conflictedCount += 1;
      continue;
    }

    const location = await resolveProjectDir(group, known.projectId, registry, candidates, {
      ...(options.gitRemoteOf ? { gitRemoteOf: options.gitRemoteOf } : {}),
      ...(options.isDirectory ? { isDirectory: options.isDirectory } : {}),
      platform,
    });
    if (!location) continue; // not locatable on this machine — skip entirely, never mint (spec §4.5)

    let projectId = known.projectId;
    if (!projectId) {
      if (mode === 'status') {
        newProjectCount += 1;
        continue;
      }
      const minted = resolveOrMintProject(registry, group.identity);
      registry = minted.registry;
      projectId = minted.projectId;
      mintedAny = true;
    }

    groupProjectIds.set(group.identityKey, projectId);
    if (seen.has(projectId)) continue; // dedup: first-resolved group for this Project ID wins
    seen.add(projectId);
    resolved.push({ projectId, dir: location.dir, ...(location.gitRemote ? { gitRemote: location.gitRemote } : {}) });
  }

  if (mode === 'stage' && mintedAny) await writeLocalRegistry(stackHome, registry);
  return { resolved, registry, newProjectCount, conflictedCount, groupProjectIds };
};

type PlannedEntry = {
  projectId: string;
  dir: string;
  plan: Awaited<ReturnType<typeof planProjectSync>>;
  scanResult: ScanResult;
};

const planResolvedProjects = async (
  stackHome: string,
  resolvedProjects: ResolvedProject[],
  groupProjectIds: Map<string, string>,
  options: CanonicalDiscoveryOptions,
): Promise<PlannedEntry[]> => {
  const platform = options.platform ?? process.platform;
  const resolveProjectId = (item: DiscoveredMemoryItem): string | undefined =>
    item.project ? groupProjectIds.get(groupKeyOf(item.project, platform)) : undefined;
  const out: PlannedEntry[] = [];
  for (const { projectId, dir, gitRemote } of resolvedProjects) {
    const scanOptions = {
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      projects: [{ dir, ...(gitRemote ? { gitRemote } : {}) }],
      platform,
      ...(options.gitRemoteOf ? { gitRemoteOf: options.gitRemoteOf } : {}),
      ...(options.isDirectory ? { isDirectory: options.isDirectory } : {}),
      resolveProjectId,
    };
    const plan = await planProjectSync({ projectId, dir }, stackHome, scanOptions);
    const scanResult = await scanClaudeProject({ projectId, dir }, scanOptions);
    out.push({ projectId, dir, plan, scanResult });
  }
  return out;
};

const toSummary = (entry: PlannedEntry, imported: string[], pending: number): CanonicalProjectSummary => ({
  projectId: entry.projectId,
  imported,
  pending,
  conflicts: entry.plan.actions
    .filter((a): a is Extract<typeof a, { kind: 'conflict' }> => a.kind === 'conflict')
    .map((a) => ({ path: a.path, reason: a.reason })),
  sourceConflicts: entry.plan.sourceConflicts.map((c) => c.canonicalPath),
  guardedPaths: entry.plan.guardedPaths,
});

const pendingCountOf = (plan: PlannedEntry['plan']): number =>
  plan.actions.filter((a) => a.kind === 'import-edit' || a.kind === 'import-delete').length;

export type CanonicalMemoryStatusResult = {
  projects: CanonicalProjectSummary[];
  /** Locatable project-scope identities discovered on this machine that have no
   * registered Project ID yet — `stak add .` would mint and import them. Read-only:
   * this count never mints anything itself. */
  newProjects: number;
  /** Project identities with genuinely ambiguous resolution (more than one existing
   * Project ID claims or is bound to the same identity) — never counted as
   * `newProjects`, never staged; the user must run `stak project` to resolve them. */
  conflictedProjects: number;
};

/** Read-only: plans every syncable project's sync but never imports, mints, or
 * writes anything (not the registry, not canonical Memory, not the projection). */
export const canonicalMemoryStatus = async (
  stackHome: string,
  options: CanonicalDiscoveryOptions = {},
): Promise<CanonicalMemoryStatusResult> => {
  const { resolved, newProjectCount, conflictedCount, groupProjectIds } = await enumerateSyncableProjects(
    stackHome,
    options,
    'status',
  );
  const entries = await planResolvedProjects(stackHome, resolved, groupProjectIds, options);
  return {
    projects: entries.map((entry) => toSummary(entry, [], pendingCountOf(entry.plan))),
    newProjects: newProjectCount,
    conflictedProjects: conflictedCount,
  };
};

export type CanonicalMemoryStageResult = {
  projects: CanonicalProjectSummary[];
  /** Same meaning as `CanonicalMemoryStatusResult.conflictedProjects` — reported here
   * too so `stak add .` never silently drops an ambiguous identity without saying so. */
  conflictedProjects: number;
};

/** `stak add .`'s canonical-Memory half: migrate once, then mint/resolve a Project ID
 * for and import every LOCATABLE project's native edits into canonical Memory — not
 * only machine-bound ones (see `enumerateSyncableProjects`). */
export const stageCanonicalMemory = async (
  stackHome: string,
  options: CanonicalDiscoveryOptions = {},
): Promise<CanonicalMemoryStageResult> => {
  await migrateLocalStore(stackHome);
  const { resolved, conflictedCount, groupProjectIds } = await enumerateSyncableProjects(stackHome, options, 'stage');
  const entries = await planResolvedProjects(stackHome, resolved, groupProjectIds, options);
  const summaries: CanonicalProjectSummary[] = [];
  for (const entry of entries) {
    const { imported } = await applyImportActions({ projectId: entry.projectId, dir: entry.dir }, stackHome, entry.scanResult, entry.plan.actions);
    summaries.push(toSummary(entry, imported, 0));
  }
  return { projects: summaries, conflictedProjects: conflictedCount };
};

/** The `resolveProjectId` callback the canonical scan/migration functions expect,
 * wired to this CLI's already-proven identity resolution (`canonical-identity.ts`,
 * unchanged by this feature) so `@stack/memory` itself never depends on it. Exported
 * for callers that need the single-item resolver directly (`planResolvedProjects`
 * above uses its OWN `groupProjectIds`-backed resolver instead, so every item is
 * attributed to exactly the Project ID enumeration decided — see
 * `EnumerationResult.groupProjectIds`'s doc comment for why that matters). */
export const resolveProjectIdForClaudeItem = (
  item: Pick<DiscoveredMemoryItem | ManifestItem, 'project' | 'kind' | 'logicalId' | 'restoreTarget'>,
  registry: LocalRegistry,
): string | undefined => resolveCanonicalProjectId(item, registry);

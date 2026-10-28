import path from 'node:path';

import {
  encodeClaudeProjectKey,
  resolveProjectForIdentity,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
  type ProjectIdentity,
} from '@stack/memory';

/** The subset of fields a native `DiscoveredMemoryItem` and a staged `ManifestItem`
 * both already have, enough to compute canonical identity for either. */
type MemoryIdentityItem = {
  project?: ProjectIdentity | undefined;
  kind: ManifestItem['kind'];
  logicalId: string;
  restoreTarget: ManifestItem['restoreTarget'];
};

/**
 * Resolve a native Memory item's stable Project ID, if one can be PROVEN — never a
 * guess from path or name similarity.
 *
 * Two independent, already-existing mechanisms are consulted, matching how `stak
 * project`/`stak memory restore` already resolve identity:
 *  1. A registry CLAIM (git canonical remote, or a `legacy-compat` claim for a
 *     historical local path) — the normal case for a location Memory was ever
 *     actually captured/backed up from.
 *  2. An explicit machine BINDING (`stak project map`) whose directory encodes to
 *     the SAME vendor key as this item's local identity — the case for a location
 *     that was only ever EXPLICITLY mapped to an existing Project, never claimed
 *     (mapping is deliberately machine-local-only; it never promotes a path to a
 *     portable identity, so it never appears as a claim).
 *
 * A conflicted claim (two Projects claim the same identity) returns `undefined`:
 * identity that cannot be proven unambiguously is never merged.
 */
export const resolveCanonicalProjectId = (
  item: Pick<MemoryIdentityItem, 'project'>,
  registry: LocalRegistry,
): string | undefined => {
  const project = item.project;
  if (!project) return undefined;
  const claimed = resolveProjectForIdentity(registry, project);
  if (claimed.status === 'resolved') return claimed.projectId;
  if (claimed.status === 'conflict') return undefined;
  if (project.kind !== 'local') return undefined;
  const binding = registry.bindings.find(
    (candidate) =>
      encodeClaudeProjectKey(path.resolve(candidate.dir)) === project.vendorKey,
  );
  return binding?.projectId;
};

/** The logical identity a native OR staged Memory item compares/stages under. When a
 * stable Project ID can be proven, identity is (Project ID, kind, logical relative
 * path) — never the historical encoded machine path. Otherwise falls back to the raw
 * `logicalId`, keeping genuinely unprovable or unrelated items distinct. Works for
 * both a native `DiscoveredMemoryItem` and a staged `ManifestItem` — whatever the
 * comparison needs on each side. */
export const canonicalMemoryKey = (
  item: MemoryIdentityItem,
  registry: LocalRegistry,
): string => {
  const projectId = resolveCanonicalProjectId(item, registry);
  return projectId
    ? `project:${projectId}:${item.kind}:${item.restoreTarget.relativePath}`
    : item.logicalId;
};

export type MemoryIdentityConflict = {
  canonicalKey: string;
  items: DiscoveredMemoryItem[];
};

export type MemoryStagingPlan = {
  /**
   * The exact native item set to feed into `runMemoryBackup`. A canonical identity
   * already represented UNCHANGED in the existing staged manifest is OMITTED
   * entirely — it is correctly retained as-is via `runMemoryBackup`'s own
   * carry-forward, never re-added under a second, differently-encoded locator. A
   * canonical identity whose content genuinely changed is staged under its EXISTING
   * logical identity (same `logicalId`/`project`), so the commit updates that entry
   * in place instead of creating a duplicate. A genuinely new canonical identity
   * (never staged before) prefers whichever native copy's OWN identity already
   * carries a registry claim, so a location that is merely BOUND to an existing
   * Project never causes `syncRegistryForBackup` to mint a new one.
   */
  items: DiscoveredMemoryItem[];
  /**
   * Canonical-key groups whose native copies disagree on content — NEVER staged
   * (fail closed: two logical records, or an arbitrary pick, are both unacceptable).
   * Working-tree status still sees these as a real, surfaced change on its own.
   */
  conflicts: MemoryIdentityConflict[];
};

/**
 * Reconcile fresh native Memory discoveries against the EXISTING staged MAIN
 * manifest, through stable Project identity — not raw, possibly stale, encoded
 * machine locators. This is what makes `stak add .` idempotent after a project
 * relocation: Claude's own per-directory Memory folder for a project's old directory
 * commonly still exists (and is still discovered) alongside the new one, with
 * byte-identical content; without reconciling against what MAIN already has under
 * the historically-claimed identity, a native-only dedup can still pick a
 * NEVER-BEFORE-STAGED representative and inadvertently create a second manifest
 * record (and, via `syncRegistryForBackup`, a second Project).
 */
export const reconcileNativeWithStagedMemory = (
  nativeItems: DiscoveredMemoryItem[],
  stagedItems: ManifestItem[],
  registry: LocalRegistry,
): MemoryStagingPlan => {
  const stagedByKey = new Map<string, ManifestItem>();
  for (const item of stagedItems)
    stagedByKey.set(canonicalMemoryKey(item, registry), item);

  const nativeGroups = new Map<string, DiscoveredMemoryItem[]>();
  for (const item of nativeItems) {
    const key = canonicalMemoryKey(item, registry);
    const group = nativeGroups.get(key);
    if (group) group.push(item);
    else nativeGroups.set(key, [item]);
  }

  const items: DiscoveredMemoryItem[] = [];
  const conflicts: MemoryIdentityConflict[] = [];
  for (const [key, group] of nativeGroups) {
    const distinctHashes = new Set(group.map((entry) => entry.contentHash));
    if (distinctHashes.size > 1) {
      conflicts.push({ canonicalKey: key, items: group });
      continue;
    }
    const hash = group[0]?.contentHash;
    const existing = stagedByKey.get(key);
    if (existing && existing.contentHash === hash) continue; // unchanged: no-op
    const [sourceCopy] = [...group].sort((a, b) =>
      a.source.path.localeCompare(b.source.path),
    );
    if (!sourceCopy) continue;
    if (existing) {
      // Content genuinely changed: update the EXISTING logical entry in place.
      items.push({
        ...sourceCopy,
        kind: existing.kind,
        scope: existing.scope,
        logicalId: existing.logicalId,
        restoreTarget: existing.restoreTarget,
        ...(existing.project ? { project: existing.project } : {}),
      });
      continue;
    }
    // Genuinely new canonical identity: prefer a copy whose OWN identity already
    // carries a registry claim over one only reachable via a binding.
    const claimed = group.find(
      (entry) =>
        entry.project &&
        resolveProjectForIdentity(registry, entry.project).status ===
          'resolved',
    );
    items.push(claimed ?? sourceCopy);
  }
  return { items, conflicts };
};

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

/**
 * Collapse native Memory discoveries that resolve to the SAME stable Project identity
 * + the same logical relative path + the SAME content into one logical item. This is
 * the real-world "I moved/re-cloned the repo" case: Claude's own per-directory Memory
 * folder for the old location still exists and is still discovered, alongside the new
 * one, with byte-identical content.
 *
 * Never silently resolves a genuine disagreement: when discoveries sharing the same
 * logical identity have DIFFERENT content, every copy is kept distinct so the caller
 * (working-tree comparison, or staging) sees a real, surfaced change rather than an
 * arbitrarily chosen winner.
 */
export const normalizeNativeMemoryItems = (
  items: DiscoveredMemoryItem[],
  registry: LocalRegistry,
): DiscoveredMemoryItem[] => {
  const groups = new Map<string, DiscoveredMemoryItem[]>();
  for (const item of items) {
    const key = canonicalMemoryKey(item, registry);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const result: DiscoveredMemoryItem[] = [];
  for (const group of groups.values()) {
    const distinctHashes = new Set(group.map((entry) => entry.contentHash));
    if (distinctHashes.size === 1) {
      // Identical content everywhere discovered — one logical item. The specific
      // representative chosen doesn't matter (content is identical); pick
      // deterministically so results never vary run to run.
      const [representative] = [...group].sort((a, b) =>
        a.source.path.localeCompare(b.source.path),
      );
      if (representative) result.push(representative);
    } else {
      result.push(...group);
    }
  }
  return result;
};

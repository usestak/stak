import { emptyRegistry, readMemoryManifest } from '@stack/memory';
import type { DiscoveredMemoryItem, LocalRegistry } from '@stack/memory';

import { canonicalMemoryKey, normalizeNativeMemoryItems } from './canonical-identity.js';

/**
 * MACHINE (native Memory) vs MAIN (the staged local manifest) — read-only, no Cloud call.
 * Mirrors exactly what `runMemoryBackup` would decide has changed (same logical identity
 * -> `contentHash` comparison it uses when committing), so status and `add .` always
 * agree. Never writes the manifest or the content store.
 *
 * Identity is normalized through the stable Project registry (see
 * `canonical-identity.ts`): a Memory item is compared by its PROVEN logical Project +
 * relative path when one exists, not by the historical encoded machine path — so
 * relocating or re-cloning a project's directory never looks like an unstaged change
 * on its own.
 */
export type MemoryWorkingTreeStatus =
  | { state: 'no-manifest'; discovered: number }
  | { state: 'clean' }
  | { state: 'changes-not-added'; changed: number };

export type ComputeMemoryWorkingTreeStatusOptions = {
  stackHome: string;
  /** Already-scanned native Memory (reuse the caller's scan — never rescans here). */
  nativeItems: DiscoveredMemoryItem[];
  /** Machine-local Project registry (claims + bindings). Defaults to empty, which
   * degrades to raw-`logicalId` comparison (pre-normalization behavior) for every
   * item — never incorrectly merges, just can't prove relocation. */
  registry?: LocalRegistry;
};

const groupHashesByKey = <T,>(
  items: T[],
  keyOf: (item: T) => string,
  hashOf: (item: T) => string,
): Map<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const key = keyOf(item);
    const hashes = groups.get(key);
    if (hashes) hashes.add(hashOf(item));
    else groups.set(key, new Set([hashOf(item)]));
  }
  return groups;
};

export const computeMemoryWorkingTreeStatus = async (
  options: ComputeMemoryWorkingTreeStatusOptions,
): Promise<MemoryWorkingTreeStatus> => {
  const manifest = await readMemoryManifest(options.stackHome);
  if (!manifest)
    return { state: 'no-manifest', discovered: options.nativeItems.length };
  const registry = options.registry ?? emptyRegistry();

  // Collapse same-Project/same-path/same-content native duplicates (e.g. a relocated
  // or re-cloned project whose old directory's Claude Memory folder still exists)
  // into one logical item before comparing.
  const normalizedNative = normalizeNativeMemoryItems(
    options.nativeItems,
    registry,
  );
  const nativeByKey = groupHashesByKey(
    normalizedNative,
    (item) => canonicalMemoryKey(item, registry),
    (item) => item.contentHash,
  );
  const stagedByKey = groupHashesByKey(
    manifest.items,
    (item) => canonicalMemoryKey(item, registry),
    (item) => item.contentHash,
  );

  // A staged key absent from native (carried-forward/unavailable project) is not a
  // change — only a native key that disagrees with (or is entirely missing from)
  // staged counts. A key with more than one distinct hash on either side (a genuine
  // disagreement between two discovered copies, or a stale duplicate manifest record)
  // is never silently resolved — it counts as a change needing explicit attention.
  let changed = 0;
  for (const [key, nativeHashes] of nativeByKey) {
    const stagedHashes = stagedByKey.get(key);
    const clean =
      nativeHashes.size === 1 &&
      stagedHashes !== undefined &&
      stagedHashes.size === 1 &&
      [...stagedHashes][0] === [...nativeHashes][0];
    if (!clean) changed += 1;
  }
  return changed === 0 ? { state: 'clean' } : { state: 'changes-not-added', changed };
};

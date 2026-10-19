import { readMemoryManifest } from '@stack/memory';
import type { DiscoveredMemoryItem } from '@stack/memory';

/**
 * MACHINE (native Memory) vs MAIN (the staged local manifest) — read-only, no Cloud call.
 * Mirrors exactly what `runMemoryBackup` would decide has changed (same `logicalId` ->
 * `contentHash` comparison it uses when committing), so status and `add .` always agree.
 * Never writes the manifest or the content store.
 */
export type MemoryWorkingTreeStatus =
  | { state: 'no-manifest'; discovered: number }
  | { state: 'clean' }
  | { state: 'changes-not-added'; changed: number };

export type ComputeMemoryWorkingTreeStatusOptions = {
  stackHome: string;
  /** Already-scanned native Memory (reuse the caller's scan — never rescans here). */
  nativeItems: DiscoveredMemoryItem[];
};

export const computeMemoryWorkingTreeStatus = async (
  options: ComputeMemoryWorkingTreeStatusOptions,
): Promise<MemoryWorkingTreeStatus> => {
  const manifest = await readMemoryManifest(options.stackHome);
  if (!manifest)
    return { state: 'no-manifest', discovered: options.nativeItems.length };
  const stagedByLogicalId = new Map(
    manifest.items.map((item) => [item.logicalId, item.contentHash]),
  );
  // A manifest item absent from the native scan (carried-forward/unavailable project) is
  // not a change — only a native item whose content differs from (or is missing from)
  // what's staged counts.
  const changed = options.nativeItems.filter(
    (item) => stagedByLogicalId.get(item.logicalId) !== item.contentHash,
  ).length;
  return changed === 0 ? { state: 'clean' } : { state: 'changes-not-added', changed };
};

import {
  discoverClaudeMemory,
  planMemoryBackupComposition,
  projectIdentityKey,
  readLocalRegistry,
  runMemoryBackup,
  safeDirectoryBasename,
  syncRegistryForBackup,
  type BackupResult,
  type ClaudeMemoryAdapterOptions,
} from '@stack/memory';

import { normalizeNativeMemoryItems } from './canonical-identity.js';

export type StageMemoryOptions = Omit<ClaudeMemoryAdapterOptions, 'stackHome'> & {
  stackHome: string;
};

/**
 * `stak add .`'s Memory staging. Mirrors `createClaudeMemoryAdapter(...).backup()`
 * (native discovery -> composition -> `runMemoryBackup` -> registry sync) exactly,
 * with ONE addition: native discoveries are normalized through the stable Project
 * registry (`normalizeNativeMemoryItems`) before they're composed/committed, so a
 * relocated or re-cloned project's stale-but-still-discovered old directory never
 * creates a SECOND manifest record for Memory that already has one under the
 * project's canonical identity.
 *
 * `stak memory backup` (the explicit legacy command) is intentionally untouched —
 * it keeps calling the adapter's own `backup()` directly.
 */
export const stageMemoryWithProjectDedup = async (
  options: StageMemoryOptions,
): Promise<BackupResult> => {
  const nameHints = new Map<string, string>();
  const nativeItems = await discoverClaudeMemory({
    ...options,
    onLocalProjectResolved: (vendorKey, dir) => {
      const base = safeDirectoryBasename(dir);
      if (base) nameHints.set(vendorKey, base);
    },
  });
  // Same Bug-B zombie-retirement bookkeeping `adapter.ts`'s backup() does, computed
  // from the RAW (pre-dedup) discovery so Local -> Git identity-strengthening is
  // unaffected by this staging-only normalization.
  const vendorKeys = new Map<string, string>();
  for (const item of nativeItems) {
    if (item.scope !== 'project' || !item.project || !item.source.vendorKey)
      continue;
    vendorKeys.set(projectIdentityKey(item.project), item.source.vendorKey);
  }

  const registry = await readLocalRegistry(options.stackHome);
  const dedupedItems = normalizeNativeMemoryItems(nativeItems, registry);

  const composition = await planMemoryBackupComposition({
    stackHome: options.stackHome,
    nativeItems: dedupedItems,
    registry,
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    ...(options.projects ? { projects: options.projects } : {}),
  });
  const result = await runMemoryBackup({
    stackHome: options.stackHome,
    items: dedupedItems,
    carryForward: composition.carriedForward,
    ...(options.now ? { now: options.now } : {}),
  });
  await syncRegistryForBackup({ stackHome: options.stackHome, nameHints, vendorKeys });
  return result;
};

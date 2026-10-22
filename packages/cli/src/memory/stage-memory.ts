import {
  discoverClaudeMemory,
  planMemoryBackupComposition,
  readLocalRegistry,
  readMemoryManifest,
  runMemoryBackup,
  safeDirectoryBasename,
  syncRegistryForBackup,
  type BackupResult,
  type ClaudeMemoryAdapterOptions,
} from '@stack/memory';

import { reconcileNativeWithStagedMemory } from './canonical-identity.js';

export type StageMemoryOptions = Omit<ClaudeMemoryAdapterOptions, 'stackHome'> & {
  stackHome: string;
};

/**
 * `stak add .`'s Memory staging. Mirrors `createClaudeMemoryAdapter(...).backup()`
 * (native discovery -> composition -> `runMemoryBackup` -> registry sync), with ONE
 * addition: native discoveries are reconciled against the EXISTING staged MAIN
 * manifest, through stable Project identity (`reconcileNativeWithStagedMemory`),
 * before they're composed/committed. A relocated or re-cloned project's
 * stale-but-still-discovered old directory is already represented in MAIN under its
 * canonical identity, so it's never staged again as a second manifest record (and
 * registry sync never mints a second Project for it).
 *
 * `stak memory backup` (the explicit legacy command) is intentionally untouched —
 * it keeps calling the adapter's own `backup()` directly.
 */
export const stageMemoryWithProjectDedup = async (
  options: StageMemoryOptions,
): Promise<BackupResult> => {
  const nameHints = new Map<string, string>();
  const nativeItems = (
    await discoverClaudeMemory({
      ...options,
      onLocalProjectResolved: (vendorKey, dir) => {
        const base = safeDirectoryBasename(dir);
        if (base) nameHints.set(vendorKey, base);
      },
    })
  ).filter((item) => item.scope === 'global'); // project-scope Memory now goes through canonical staging (stageCanonicalMemory), not this v1 path.
  // `syncRegistryForBackup` requires a `vendorKeys` map (Bug-B zombie-retirement
  // bookkeeping, keyed by project-scope identity) — but `nativeItems` is global-only
  // now, so it can never contain a project-scope item and this is always empty.
  // Left in place only because the parameter is required; the loop that used to
  // populate it from project-scope items is gone.
  const vendorKeys = new Map<string, string>();

  const registry = await readLocalRegistry(options.stackHome);
  const stagedManifest = await readMemoryManifest(options.stackHome);
  const plan = reconcileNativeWithStagedMemory(
    nativeItems,
    stagedManifest?.items ?? [],
    registry,
  );

  const composition = await planMemoryBackupComposition({
    stackHome: options.stackHome,
    nativeItems: plan.items,
    registry,
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    ...(options.projects ? { projects: options.projects } : {}),
  });
  const result = await runMemoryBackup({
    stackHome: options.stackHome,
    items: plan.items,
    carryForward: composition.carriedForward,
    ...(options.now ? { now: options.now } : {}),
  });
  await syncRegistryForBackup({ stackHome: options.stackHome, nameHints, vendorKeys });
  return result;
};

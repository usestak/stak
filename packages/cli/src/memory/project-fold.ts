import {
  adoptReconciledProjectId,
  foldStoredCanonicalState,
  learnProjectAliases,
  projectAliasResolver,
  readLocalRegistry,
  writeLocalRegistry,
  type CanonicalMainManifest,
  type PortableRegistrySnapshot,
  type ProjectFoldReport,
  type ProjectionFile,
} from '@stack/memory';

/**
 * Spec §4.2.1, "When two Project IDs turn out to be the same project" — the
 * CLI side: it only orchestrates. The fold itself (`foldProjectAliases` and
 * friends) and every Cloud read's fold (`fetchRemoteCanonical`) live in
 * `@stack/memory`. Every caller already holds the Memory lock.
 */

/** One former Project ID folded into its surviving one, for the user's line. */
export type ProjectFoldNote = { fromProjectId: string; toProjectId: string; keptBoth: number };

export const foldNotesOf = (report: ProjectFoldReport): ProjectFoldNote[] =>
  report.merged.map((pair) => ({
    ...pair,
    keptBoth: report.keptBoth.filter((k) => k.fromProjectId === pair.fromProjectId).length,
  }));

export type ProjectMemoryFold = {
  /** Non-empty exactly when the fold changed this machine's state. */
  notes: ProjectFoldNote[];
  /** The folded local Memory and projection (the on-disk state after a
   * persisted fold; in memory only for `persist: false`). */
  main: CanonicalMainManifest;
  projection: ProjectionFile;
};

/**
 * Fold this machine's canonical bookkeeping (local Memory, base, pending merge,
 * projection) before any sync decision, with the alias map local registry ∪
 * `remoteSnapshot` (the fetched Cloud generation's, when there is one).
 *
 * With a remote snapshot, a machine that never got Cloud's reconciliation
 * LEARNS the alias first ("every machine learns them"): its own record of a
 * former ID is retired into the surviving ID (`learnProjectAliases`), so its
 * next `stak add .` stays on the surviving ID. Nothing else is taken from the
 * snapshot. `persist: false` (`stak status`) writes nothing at all.
 */
export const foldProjectMemory = async (
  stackHome: string,
  options: { remoteSnapshot?: PortableRegistrySnapshot | undefined; persist?: boolean } = {},
): Promise<ProjectMemoryFold> => {
  const persist = options.persist ?? true;
  let registry = await readLocalRegistry(stackHome);
  if (options.remoteSnapshot) {
    const learned = learnProjectAliases(registry, options.remoteSnapshot);
    if (learned.adopted.length > 0) {
      registry = learned.registry;
      if (persist) await writeLocalRegistry(stackHome, registry);
    }
  }
  const aliasOf = projectAliasResolver(registry, options.remoteSnapshot);
  const result = await foldStoredCanonicalState(stackHome, aliasOf, { persist });
  return {
    notes: result.changed ? foldNotesOf(result.report) : [],
    main: result.main,
    projection: result.projection,
  };
};

/**
 * The post-command check-in's handling of Cloud's Git-canonical reconciliation
 * (`syncProjects` → `reconciled`): adopt Cloud's Project ID in the registry
 * (recording the alias), then fold this machine's Memory right away — not just
 * the registry, which split the project in two. The caller holds the lock.
 */
export const applyCheckinReconciliation = async (
  stackHome: string,
  reconciled: readonly { fromProjectId: string; toProjectId: string }[],
): Promise<{ merged: ProjectFoldNote[] }> => {
  let registry = await readLocalRegistry(stackHome);
  for (const { fromProjectId, toProjectId } of reconciled)
    registry = adoptReconciledProjectId(registry, fromProjectId, toProjectId);
  await writeLocalRegistry(stackHome, registry);
  const { notes } = await foldProjectMemory(stackHome);
  return { merged: notes };
};

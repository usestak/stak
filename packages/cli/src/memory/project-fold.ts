import {
  adoptReconciledProjectId,
  foldProjectAliases,
  foldStoredCanonicalState,
  learnProjectAliases,
  readLocalRegistry,
  trustedAliasResolver,
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
  /** The alias map this fold used (local registry ∪ vetted snapshot). */
  aliasOf: (projectId: string) => string;
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
    // Vetted (review fix I1): only aliases backed by a shared claim; and (I2)
    // learned former IDs are kept on the surviving record too.
    const learned = learnProjectAliases(registry, options.remoteSnapshot);
    if (learned.changed) {
      registry = learned.registry;
      if (persist) await writeLocalRegistry(stackHome, registry);
    }
  }
  const aliasOf = trustedAliasResolver(registry, options.remoteSnapshot);
  const result = await foldStoredCanonicalState(stackHome, aliasOf, { persist });
  return {
    notes: result.changed ? foldNotesOf(result.report) : [],
    main: result.main,
    projection: result.projection,
    aliasOf,
  };
};

/**
 * Review fix C1: wrap a merge engine's `fetchRemote` so that EVERY fetch —
 * including a retry after Cloud moved — first learns aliases from that
 * fetch's snapshot and folds local Memory, base, pending merge and projection
 * (persisted; the caller holds the lock), and then returns the remote folded
 * with that SAME alias map. The engine reads base and local only after
 * fetching (`pushCanonicalMemory`), so all three sides of every attempt's
 * merge agree. `onNotes` collects what each fold changed.
 */
export const foldingFetch = <R extends { main: CanonicalMainManifest }>(
  stackHome: string,
  fetch: () => Promise<R | null>,
  snapshotOf: () => PortableRegistrySnapshot | undefined,
  onNotes: (notes: ProjectFoldNote[]) => void,
): (() => Promise<R | null>) =>
  async () => {
    const result = await fetch();
    const fold = await foldProjectMemory(stackHome, { remoteSnapshot: snapshotOf() });
    onNotes(fold.notes);
    if (!result) return result;
    return { ...result, main: foldProjectAliases(result.main, fold.aliasOf).main };
  };

/** Accumulates fold notes across several folds in one command (one per pair). */
export const foldNoteCollector = () => {
  const byFrom = new Map<string, ProjectFoldNote>();
  return {
    add: (notes: ProjectFoldNote[]) => {
      for (const note of notes) {
        const prior = byFrom.get(note.fromProjectId);
        byFrom.set(note.fromProjectId, prior ? { ...note, keptBoth: prior.keptBoth + note.keptBoth } : note);
      }
    },
    notes: (): ProjectFoldNote[] => [...byFrom.values()],
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

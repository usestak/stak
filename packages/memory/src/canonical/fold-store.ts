import type { CanonicalMainManifest } from './domain.js';
import { pendingMergeSchema } from './merge.js';
import {
  emptyProjectFoldReport,
  foldPendingMerge,
  foldProjectAliases,
  foldProjection,
  type ProjectFoldReport,
} from './project-fold.js';
import {
  readCanonicalBase,
  readCanonicalMain,
  readPendingMerge,
  readProjection,
  writeCanonicalBase,
  writeCanonicalMain,
  writePendingMerge,
  writeProjection,
  type ProjectionFile,
} from './store.js';

export type StoredFoldResult = {
  /** What changed in this machine's own Memory (`main.json`): the pairs folded
   * there and the documents kept both. Pairs folded only in the base, the
   * pending merge or the projection are added to `merged` too. */
  report: ProjectFoldReport;
  /** Whether anything at all differs from what is on disk. */
  changed: boolean;
  /** The folded local state (returned even when not persisted). */
  main: CanonicalMainManifest;
  projection: ProjectionFile;
};

/**
 * Spec §4.2.1: fold every piece of this machine's canonical bookkeeping —
 * local `main.json`, `base.json`, a pending `merge.json` and the Claude
 * projection — with ONE alias map, so all three sides of every later merge
 * agree. With `persist: true` each changed file is written once (the caller
 * holds the Memory lock); with `persist: false` nothing is written (`stak
 * status`). Native agent files are never touched: both IDs point at the same
 * project folder, so the moved projection entries still describe them.
 */
export const foldStoredCanonicalState = async (
  stackHome: string,
  aliasOf: (projectId: string) => string,
  options: { persist: boolean },
): Promise<StoredFoldResult> => {
  const merged = new Map<string, { fromProjectId: string; toProjectId: string }>();
  const note = (report: ProjectFoldReport) => {
    for (const pair of report.merged) merged.set(pair.fromProjectId, pair);
  };

  const main = await readCanonicalMain(stackHome);
  const foldedMain = foldProjectAliases(main, aliasOf);
  note(foldedMain.report);

  const base = await readCanonicalBase(stackHome);
  const foldedBase = base ? foldProjectAliases(base.main, aliasOf) : undefined;
  if (foldedBase) note(foldedBase.report);

  const pending = await readPendingMerge(stackHome, pendingMergeSchema);
  const foldedPending = pending ? foldPendingMerge(pending, aliasOf) : undefined;
  if (foldedPending) note(foldedPending.report);

  const projection = await readProjection(stackHome, 'claude');
  const foldedProjection = foldProjection(projection, aliasOf);
  if (foldedProjection.changed)
    for (const id of Object.keys(projection.projects))
      if (aliasOf(id) !== id) merged.set(id, { fromProjectId: id, toProjectId: aliasOf(id) });

  const mainChanged = foldedMain.main !== main;
  const baseChanged = base !== null && foldedBase !== undefined && foldedBase.main !== base.main;
  const pendingChanged = foldedPending?.changed === true;
  const changed = mainChanged || baseChanged || pendingChanged || foldedProjection.changed;

  if (options.persist && changed) {
    if (mainChanged) await writeCanonicalMain(stackHome, foldedMain.main);
    if (baseChanged && base && foldedBase) await writeCanonicalBase(stackHome, { ...base, main: foldedBase.main });
    if (pendingChanged && foldedPending) await writePendingMerge(stackHome, foldedPending.pending);
    if (foldedProjection.changed) await writeProjection(stackHome, 'claude', foldedProjection.projection);
  }

  const report = emptyProjectFoldReport();
  report.merged = [...merged.values()].sort((a, b) =>
    a.fromProjectId < b.fromProjectId ? -1 : a.fromProjectId > b.fromProjectId ? 1 : 0,
  );
  report.keptBoth = foldedMain.report.keptBoth;
  return { report, changed, main: foldedMain.main, projection: foldedProjection.projection };
};

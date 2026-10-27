import type {
  CanonicalDoc,
  CanonicalMainManifest,
  CanonicalProjectMemory,
} from './domain.js';
import { keepBothPath, type PendingMerge } from './merge.js';
import type { ProjectionFile } from './store.js';

/**
 * Spec §4.2.1, "When two Project IDs turn out to be the same project": fold
 * Memory filed under a FORMER Project ID into its SURVIVING one. Pure and
 * deterministic, so every machine folding the same input gets the same result;
 * idempotent, since afterwards the former ID holds nothing. `aliasOf` maps any
 * Project ID to its surviving ID (itself when it is not an alias) — see
 * `projectAliasResolver` in `project/registry.ts`.
 *
 * Fold rules, per path, folding each former project (in Project ID order) into
 * its surviving one:
 *  - only the former ID has the path: the document moves to the surviving ID;
 *  - same content on both: one document (the surviving ID's);
 *  - different content on both: the surviving ID's version keeps the path and
 *    the former ID's is kept at `keepBothPath` (§8.3's name, from the former
 *    version's content hash, extended only on a collision) — nothing is lost;
 *  - a present document beats a deletion of the same path, so a fold never
 *    deletes content; two deletions keep the surviving ID's.
 */

export type ProjectFoldReport = {
  /** Every former Project ID folded, with the surviving ID it went into. */
  merged: { fromProjectId: string; toProjectId: string }[];
  /** Every document kept both: the surviving ID's version stayed at `path`, the
   * former ID's (`fromProjectId`) version was kept at `keptAt`. */
  keptBoth: {
    projectId: string;
    path: string;
    keptAt: string;
    fromProjectId: string;
  }[];
};

export const emptyProjectFoldReport = (): ProjectFoldReport => ({
  merged: [],
  keptBoth: [],
});

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPath = (a: { path: string }, b: { path: string }): number =>
  byString(a.path, b.path);

/** Fold one former document into the surviving project's documents (by path). */
const foldDoc = (
  docs: Map<string, CanonicalDoc>,
  doc: CanonicalDoc,
  onKeptBoth: (keptAt: string) => void,
): void => {
  const existing = docs.get(doc.path);
  if (existing === undefined) {
    docs.set(doc.path, doc);
    return;
  }
  if (doc.state === 'deleted') return; // surviving present or deleted wins over a former deletion
  if (existing.state === 'deleted') {
    docs.set(doc.path, doc); // present beats deletion
    return;
  }
  if (existing.contentHash === doc.contentHash) return; // same content: one document
  // Different content: keep both. A candidate path is free when nothing there,
  // a deletion there (present beats deletion), or the very same content there
  // (an earlier fold of the same pair already kept it).
  const isTaken = (candidate: string): boolean => {
    const at = docs.get(candidate);
    return (
      at !== undefined &&
      at.state === 'present' &&
      at.contentHash !== doc.contentHash
    );
  };
  const keptAt = keepBothPath(doc.path, doc.contentHash, isTaken);
  docs.set(keptAt, { ...doc, path: keptAt });
  onKeptBoth(keptAt);
};

export const foldProjectAliases = (
  main: CanonicalMainManifest,
  aliasOf: (projectId: string) => string,
): { main: CanonicalMainManifest; report: ProjectFoldReport } => {
  const formers = main.projects.filter(
    (p) => aliasOf(p.projectId) !== p.projectId,
  );
  if (formers.length === 0) return { main, report: emptyProjectFoldReport() };

  const report = emptyProjectFoldReport();
  // Surviving ID -> its folded documents, seeded with its own.
  const survivors = new Map<string, Map<string, CanonicalDoc>>();
  const docsFor = (projectId: string): Map<string, CanonicalDoc> => {
    let docs = survivors.get(projectId);
    if (!docs) {
      const own = main.projects
        .filter((p) => p.projectId === projectId)
        .flatMap((p) => p.documents);
      docs = new Map([...own].sort(byPath).map((d) => [d.path, d]));
      survivors.set(projectId, docs);
    }
    return docs;
  };
  // Merge duplicate entries of the same former ID first (defensive), then fold
  // each former project in Project ID order, its documents in path order.
  const formerDocs = new Map<string, CanonicalDoc[]>();
  for (const project of formers)
    formerDocs.set(project.projectId, [
      ...(formerDocs.get(project.projectId) ?? []),
      ...project.documents,
    ]);
  for (const fromProjectId of [...formerDocs.keys()].sort(byString)) {
    const toProjectId = aliasOf(fromProjectId);
    const docs = docsFor(toProjectId);
    for (const doc of [...(formerDocs.get(fromProjectId) ?? [])].sort(byPath))
      foldDoc(docs, doc, (keptAt) =>
        report.keptBoth.push({
          projectId: toProjectId,
          path: doc.path,
          keptAt,
          fromProjectId,
        }),
      );
    report.merged.push({ fromProjectId, toProjectId });
  }

  // Rebuild: untouched projects keep their identity and position; a surviving
  // project takes the place of its first appearance (its own entry, else the
  // first former ID folded into it).
  const projects: CanonicalProjectMemory[] = [];
  const placed = new Set<string>();
  for (const project of main.projects) {
    const target = aliasOf(project.projectId);
    if (!survivors.has(target)) {
      projects.push(project);
      continue;
    }
    if (placed.has(target)) continue;
    placed.add(target);
    projects.push({
      projectId: target,
      documents: [...(survivors.get(target)?.values() ?? [])].sort(byPath),
    });
  }
  return { main: { ...main, projects }, report };
};

/**
 * Fold the N/P/C projection (`projections/<adapter>.json`, "last synced" native
 * hashes): a former ID's entries move to the surviving ID. Both IDs point at
 * the same project folder, so they describe the same native files; for a path
 * both have, the surviving ID's entry is kept. Never touches native files.
 */
export const foldProjection = (
  file: ProjectionFile,
  aliasOf: (projectId: string) => string,
): { projection: ProjectionFile; changed: boolean } => {
  const ids = Object.keys(file.projects);
  if (ids.every((id) => aliasOf(id) === id))
    return { projection: file, changed: false };
  const projects: Record<string, Record<string, string>> = {};
  for (const id of ids)
    if (aliasOf(id) === id) projects[id] = { ...file.projects[id] };
  for (const id of ids.filter((x) => aliasOf(x) !== x).sort(byString)) {
    const target = aliasOf(id);
    const entries = (projects[target] ??= {});
    for (const [docPath, hash] of Object.entries(file.projects[id] ?? {}).sort(
      ([a], [b]) => byString(a, b),
    ))
      if (entries[docPath] === undefined) entries[docPath] = hash;
  }
  return { projection: { ...file, projects }, changed: true };
};

/**
 * Fold a pending merge (`canonical/merge.json`): its merged manifest, the
 * Project IDs of its conflict list (deduplicated) and of its resolved entries.
 * A pending merge that no longer matches the folded sides afterwards is caught
 * by the existing staleness check (`merge-stale`) and merged again.
 */
export const foldPendingMerge = (
  pending: PendingMerge,
  aliasOf: (projectId: string) => string,
): { pending: PendingMerge; report: ProjectFoldReport; changed: boolean } => {
  const { main: merged, report } = foldProjectAliases(pending.merged, aliasOf);
  const idsChange = [...pending.conflicts, ...(pending.resolved ?? [])].some(
    (c) => aliasOf(c.projectId) !== c.projectId,
  );
  if (merged === pending.merged && !idsChange)
    return { pending, report, changed: false };
  const seen = new Set<string>();
  const conflicts = pending.conflicts
    .map((c) => ({ ...c, projectId: aliasOf(c.projectId) }))
    .filter((c) => {
      const key = `${c.projectId}\u0000${c.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    pending: {
      ...pending,
      merged,
      conflicts,
      ...(pending.resolved
        ? {
            resolved: pending.resolved.map((r) => ({
              ...r,
              projectId: aliasOf(r.projectId),
            })),
          }
        : {}),
    },
    report,
    changed: true,
  };
};

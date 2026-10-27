import { z } from 'zod';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalDocSchema,
  canonicalMainManifestSchema,
  type CanonicalDoc,
  type CanonicalMainManifest,
  type CanonicalProjectMemory,
} from './domain.js';

export type MergeConflict = {
  projectId: string;
  path: string;
  reason: 'edit-edit' | 'edit-delete' | 'delete-delete';
};

export const mergeConflictSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  reason: z.enum(['edit-edit', 'edit-delete', 'delete-delete']),
});

/** One conflict already resolved by `stak memory resolve` while others remain
 * (Task 14) — kept so a later resolve can prove the pending merge still matches
 * local Memory and the sync base before applying anything. */
export const pendingMergeResolutionSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  keep: z.enum(['local', 'cloud', 'both']),
  altPath: z.string().optional(),
  /** Local canonical state of `path` when this resolution was made (`null` =
   * absent). A later resolve refuses (`merge-stale`) if it has changed since —
   * otherwise finalizing would write the recorded choice over a newer edit. */
  local: canonicalDocSchema.nullable().optional(),
});
export type PendingMergeResolution = z.infer<
  typeof pendingMergeResolutionSchema
>;

/** `canonical/merge.json` (spec Appendix A.1): written by push/pull on a
 * conflict as `{ basedOnGeneration, merged, conflicts }`; `resolved` is added
 * only by a partial `stak memory resolve`. */
export const pendingMergeSchema = z.object({
  basedOnGeneration: z.number().int().nonnegative(),
  merged: canonicalMainManifestSchema,
  conflicts: z.array(mergeConflictSchema),
  resolved: z.array(pendingMergeResolutionSchema).optional(),
});
export type PendingMerge = z.infer<typeof pendingMergeSchema>;

export type MergeOutcome = {
  merged: CanonicalMainManifest;
  conflicts: MergeConflict[];
};

const docsByPath = (
  project: CanonicalProjectMemory | undefined,
): Map<string, CanonicalDoc> =>
  new Map((project?.documents ?? []).map((doc) => [doc.path, doc]));

const sameDoc = (
  a: CanonicalDoc | undefined,
  b: CanonicalDoc | undefined,
): boolean => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.state !== b.state) return false;
  return a.state === 'present' && b.state === 'present'
    ? a.contentHash === b.contentHash
    : a.state === 'deleted' && b.state === 'deleted'
      ? a.lastContentHash === b.lastContentHash
      : false;
};

const isGone = (doc: CanonicalDoc | undefined): boolean =>
  doc === undefined || doc.state === 'deleted';

/**
 * Three-way merge of one project's documents. `base` is what this machine last
 * synced with Cloud; `local` is this machine's current canonical state; `remote`
 * is Cloud's current latest. A document changed only on one side since `base` is
 * taken from that side; changed identically on both sides agrees; changed
 * differently (or edited on one side and deleted on the other) is a conflict and
 * is OMITTED from `merged` (never guessed).
 */
const mergeProject = (
  projectId: string,
  base: CanonicalProjectMemory | undefined,
  local: CanonicalProjectMemory | undefined,
  remote: CanonicalProjectMemory | undefined,
): { documents: CanonicalDoc[]; conflicts: MergeConflict[] } => {
  const baseDocs = docsByPath(base);
  const localDocs = docsByPath(local);
  const remoteDocs = docsByPath(remote);
  const paths = new Set<string>([
    ...baseDocs.keys(),
    ...localDocs.keys(),
    ...remoteDocs.keys(),
  ]);

  const documents: CanonicalDoc[] = [];
  const conflicts: MergeConflict[] = [];
  for (const path of [...paths].sort()) {
    const B = baseDocs.get(path);
    const L = localDocs.get(path);
    const R = remoteDocs.get(path);
    const localChanged = !sameDoc(B, L);
    const remoteChanged = !sameDoc(B, R);

    if (!localChanged && !remoteChanged) {
      if (B) documents.push(B);
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (L) documents.push(L);
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (R) documents.push(R);
      continue;
    }
    // Both changed since base.
    if (sameDoc(L, R)) {
      if (L) documents.push(L);
      continue;
    }
    const reason: MergeConflict['reason'] =
      isGone(L) && isGone(R)
        ? 'delete-delete'
        : isGone(L) || isGone(R)
          ? 'edit-delete'
          : 'edit-edit';
    conflicts.push({ projectId, path, reason });
    // Conflicted documents are omitted from `merged` entirely until resolved.
  }
  return { documents, conflicts };
};

export const mergeCanonical = (
  base: CanonicalMainManifest,
  local: CanonicalMainManifest,
  remote: CanonicalMainManifest,
): MergeOutcome => {
  const projectIds = new Set<string>([
    ...base.projects.map((p) => p.projectId),
    ...local.projects.map((p) => p.projectId),
    ...remote.projects.map((p) => p.projectId),
  ]);
  const projects: CanonicalProjectMemory[] = [];
  const conflicts: MergeConflict[] = [];
  for (const projectId of [...projectIds].sort()) {
    const result = mergeProject(
      projectId,
      base.projects.find((p) => p.projectId === projectId),
      local.projects.find((p) => p.projectId === projectId),
      remote.projects.find((p) => p.projectId === projectId),
    );
    projects.push({ projectId, documents: result.documents });
    conflicts.push(...result.conflicts);
  }
  return {
    merged: { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects },
    conflicts,
  };
};

/**
 * Deterministic "keep both" path for a local document kept alongside Cloud's
 * version of the same path. The suffix comes from the LOCAL version's content
 * hash so any machine resolving the same conflict picks the same name. Starts at
 * 12 hex characters, extends to 16 then the full hash only on an actual collision
 * (checked via `isTaken`, which the caller wires to "does this path already exist
 * in canonical/native/other pending resolutions").
 */
export const keepBothPath = (
  originalPath: string,
  localContentHash: string,
  isTaken: (candidate: string) => boolean,
): string => {
  const hex = localContentHash.replace(/^sha256:/, '');
  const lastSlash = originalPath.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : originalPath.slice(0, lastSlash + 1);
  const base =
    lastSlash === -1 ? originalPath : originalPath.slice(lastSlash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot); // includes leading "."
  for (const length of [12, 16, hex.length]) {
    const candidate = `${dir}${stem}.conflict-${hex.slice(0, length)}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${dir}${stem}.conflict-${hex}${ext}`;
};

export type KeepSide = 'local' | 'cloud' | 'both';

/**
 * Spec §8.3 / Appendix A.4: the document state(s) that resolving one conflict
 * produces. Each side is a document STATE, deletions included:
 *  - `local` / `cloud`: that side's document. A side that is ABSENT means the
 *    deletion, as a tombstone of the other side's present content (so the
 *    deletion propagates and the other copy is never resurrected or left
 *    silently in place).
 *  - `both`: Cloud ALWAYS keeps the original path (its document, or — when it
 *    is absent — a tombstone of local's content, exactly as `cloud` gives);
 *    when local is present, local's content is additionally kept at the
 *    deterministic `keepBothPath`. Local gone -> just Cloud's state.
 * Pure: `deletedAt` is supplied, collisions are checked through `isTaken`.
 */
export const resolveConflictDocs = (
  keep: KeepSide,
  path: string,
  local: CanonicalDoc | undefined,
  cloud: CanonicalDoc | undefined,
  deletedAt: string,
  isTaken: (candidate: string) => boolean,
): { primary: CanonicalDoc; alt?: CanonicalDoc } => {
  const tombstone = (lastContentHash: string): CanonicalDoc => ({
    path,
    state: 'deleted',
    lastContentHash,
    deletedAt,
  });
  const take = (
    chosen: CanonicalDoc | undefined,
    other: CanonicalDoc | undefined,
  ): CanonicalDoc => {
    if (chosen) return chosen;
    if (other?.state === 'present') return tombstone(other.contentHash);
    if (other) return other;
    throw new Error(`Neither side has ${path}; there is nothing to resolve.`);
  };
  if (keep === 'local') return { primary: take(local, cloud) };
  const primary = take(cloud, local);
  if (keep === 'cloud' || local?.state !== 'present') return { primary };
  return {
    primary,
    alt: { ...local, path: keepBothPath(path, local.contentHash, isTaken) },
  };
};

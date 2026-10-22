import type { CanonicalDoc } from './domain.js';

export type NativeEntry = { path: string; contentHash: string };

export type SyncAction =
  | { kind: 'none' }
  | { kind: 'import-edit'; path: string; contentHash: string }
  | { kind: 'import-delete'; path: string }
  | { kind: 'materialize-write'; path: string; contentHash: string }
  | { kind: 'materialize-delete'; path: string }
  | { kind: 'already-synced'; path: string; contentHash: string }
  | {
      kind: 'conflict';
      path: string;
      reason: 'edit-edit' | 'edit-delete' | 'delete-edit' | 'adopt-mismatch';
    };

const canonicalContentHash = (doc: CanonicalDoc | undefined): string | undefined =>
  doc === undefined
    ? undefined
    : doc.state === 'present'
      ? doc.contentHash
      : undefined; // deleted carries no "current" content

const canonicalTombstoneHash = (doc: CanonicalDoc | undefined): string | undefined =>
  doc?.state === 'deleted' ? doc.lastContentHash : undefined;

/**
 * Plan sync actions for one project's documents, given its native entries, its
 * last-synced projection (canonical path -> hash), and its canonical documents.
 * Pure: no I/O, no adapter awareness. One action per path that appears on any
 * side. See `docs/superpowers/specs/2026-10-22-stak-native-project-memory-design.md`
 * section 6 and Appendix A.2 for the table this implements.
 */
export const planSync = (input: {
  native: NativeEntry[];
  projection: Record<string, string>;
  canonical: CanonicalDoc[];
}): SyncAction[] => {
  const nativeByPath = new Map(input.native.map((entry) => [entry.path, entry.contentHash]));
  const canonicalByPath = new Map(input.canonical.map((doc) => [doc.path, doc]));
  const paths = new Set<string>([
    ...nativeByPath.keys(),
    ...Object.keys(input.projection),
    ...canonicalByPath.keys(),
  ]);

  const actions: SyncAction[] = [];
  for (const path of [...paths].sort()) {
    const N = nativeByPath.get(path); // undefined = native file absent
    const P = input.projection[path]; // undefined = never synced
    const canonicalDoc = canonicalByPath.get(path);
    const C = canonicalContentHash(canonicalDoc); // undefined = canonical absent or deleted
    const tombstone = canonicalTombstoneHash(canonicalDoc);

    // Tombstone-resurrection guard: a native file whose content exactly matches
    // what was deleted is never treated as a new import, but only in first sighting.
    if (P === undefined && tombstone !== undefined && N !== undefined && N === tombstone && C === undefined) {
      actions.push({ kind: 'none' });
      continue;
    }

    if (P === undefined) {
      // First sighting: nothing synced yet for this path.
      if (N === undefined && C === undefined) {
        actions.push({ kind: 'none' });
      } else if (N !== undefined && C === undefined) {
        // Import new native file (guard already prevents re-imports matching tombstone)
        actions.push({ kind: 'import-edit', path, contentHash: N });
      } else if (N === undefined && C !== undefined) {
        actions.push({ kind: 'materialize-write', path, contentHash: C });
      } else if (N !== undefined && C !== undefined) {
        if (N === C) actions.push({ kind: 'already-synced', path, contentHash: N });
        else actions.push({ kind: 'conflict', path, reason: 'adopt-mismatch' });
      } else {
        actions.push({ kind: 'none' });
      }
      continue;
    }

    const nMatchesP = N === P;
    const cMatchesP = C === P;

    if (nMatchesP && cMatchesP) {
      actions.push({ kind: 'none' });
    } else if (!nMatchesP && cMatchesP) {
      // Native changed, canonical did not.
      if (N === undefined) actions.push({ kind: 'import-delete', path });
      else actions.push({ kind: 'import-edit', path, contentHash: N });
    } else if (nMatchesP && !cMatchesP) {
      // Canonical changed, native did not.
      if (C === undefined) actions.push({ kind: 'materialize-delete', path });
      else actions.push({ kind: 'materialize-write', path, contentHash: C });
    } else {
      // Both changed since the last sync.
      if (N !== undefined && C !== undefined && N === C) {
        actions.push({ kind: 'already-synced', path, contentHash: N });
      } else if (N !== undefined && C !== undefined) {
        actions.push({ kind: 'conflict', path, reason: 'edit-edit' });
      } else if (N === undefined && C !== undefined) {
        actions.push({ kind: 'conflict', path, reason: 'delete-edit' });
      } else if (N !== undefined && C === undefined) {
        actions.push({ kind: 'conflict', path, reason: 'edit-delete' });
      } else {
        // Both deleted since the last sync: they already agree.
        actions.push({ kind: 'none' });
      }
    }
  }
  return actions;
};

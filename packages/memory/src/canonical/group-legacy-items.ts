import type { ManifestItem } from '../domain.js';
import { keepBothPath } from './merge.js';
import { claudeCanonicalPathOf } from './claude-project-adapter.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';

export type GroupedResult = { main: CanonicalMainManifest; keptBothDuplicates: number };

/**
 * Pure grouping of legacy v1 items, each already tagged with its resolved Project
 * ID (`__projectId`), into canonical documents — identical duplicates collapse,
 * differing duplicates keep both under the deterministic keep-both naming from
 * `merge.ts`, with the most recently captured copy keeping the original path.
 * Identity resolution itself is the caller's job (`migrate.ts` mints through the
 * local registry; `convert-v1.ts` reads a snapshot/registry read-only) so this
 * function stays pure and shared between both.
 */
export const groupLegacyItems = (
  items: Array<ManifestItem & { __projectId: string }>,
): GroupedResult => {
  const byProject = new Map<string, Array<ManifestItem & { __projectId: string }>>();
  for (const item of items) {
    const group = byProject.get(item.__projectId) ?? [];
    group.push(item);
    byProject.set(item.__projectId, group);
  }

  let keptBothDuplicates = 0;
  const main: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
  for (const [projectId, group] of [...byProject].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const byPath = new Map<string, Array<ManifestItem & { __projectId: string }>>();
    for (const item of group) {
      const canonicalPath = claudeCanonicalPathOf(item);
      if (!canonicalPath) continue;
      const bucket = byPath.get(canonicalPath) ?? [];
      bucket.push(item);
      byPath.set(canonicalPath, bucket);
    }
    const documents: CanonicalDoc[] = [];
    const takenPaths = new Set<string>(byPath.keys());
    for (const [canonicalPath, bucket] of [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      // Deduplicate identical copies by hash FIRST, keeping the MOST RECENTLY
      // captured copy per hash — never first-seen, which would make the result
      // depend on array order (the exact bug fixed in migrate.ts, Task 6).
      const distinctByHash = new Map<string, ManifestItem & { __projectId: string }>();
      for (const entry of bucket) {
        const prev = distinctByHash.get(entry.contentHash);
        if (!prev || entry.capturedAt > prev.capturedAt) distinctByHash.set(entry.contentHash, entry);
      }
      const distinct = [...distinctByHash.values()];
      if (distinct.length === 1) {
        const winner = distinct[0]!;
        documents.push({
          path: canonicalPath,
          state: 'present',
          contentHash: winner.contentHash,
          importedFrom: 'claude',
          importedAt: winner.capturedAt,
        });
        continue;
      }
      // Deterministic tie-break: `capturedAt` descending, then `contentHash`
      // ascending, so two items captured in the same backup run (same
      // `capturedAt`) still resolve the same way on every machine.
      const sorted = [...distinct].sort((a, b) =>
        a.capturedAt !== b.capturedAt
          ? a.capturedAt < b.capturedAt ? 1 : -1
          : a.contentHash < b.contentHash ? -1 : 1,
      );
      const [primary, ...rest] = sorted;
      documents.push({
        path: canonicalPath,
        state: 'present',
        contentHash: primary!.contentHash,
        importedFrom: 'claude',
        importedAt: primary!.capturedAt,
      });
      for (const extra of rest) {
        const altPath = keepBothPath(canonicalPath, extra.contentHash, (candidate) => takenPaths.has(candidate));
        takenPaths.add(altPath);
        documents.push({
          path: altPath,
          state: 'present',
          contentHash: extra.contentHash,
          importedFrom: 'claude',
          importedAt: extra.capturedAt,
        });
        keptBothDuplicates += 1;
      }
    }
    main.projects.push({ projectId, documents });
  }
  return { main, keptBothDuplicates };
};

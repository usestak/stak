import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManifestItem, ProjectIdentity } from '../domain.js';
import { memoryStorePaths, readMemoryManifest, readMemoryObject, writeMemoryManifest } from '../store.js';
import { readLocalRegistry, writeLocalRegistry } from '../project/registry-store.js';
import { resolveOrMintProject } from '../project/registry.js';
import { claudeCanonicalPathOf } from './claude-project-adapter.js';
import { keepBothPath } from './merge.js';
import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  type CanonicalDoc,
  type CanonicalMainManifest,
} from './domain.js';
import { readCanonicalMain, writeCanonicalMain, readProjection, writeProjection } from './store.js';

export class MigrationError extends Error {
  constructor(public readonly code: 'migration-invalid', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export type MigrationSummary = {
  migratedDocuments: number;
  keptBothDuplicates: number;
  alreadyMigrated: boolean;
};

const premigrationBackupPath = (stackHome: string) =>
  path.join(memoryStorePaths(stackHome).manifests, 'current.v1-premigration.json');

/** Step A: write the pre-migration backup exactly once. A pre-existing backup is
 * read back unchanged (never overwritten), which is what makes later steps safe
 * to resume from after any crash. */
const ensureBackup = async (stackHome: string) => {
  const file = premigrationBackupPath(stackHome);
  try {
    const raw = await readFile(file, 'utf8');
    return { manifest: JSON.parse(raw) as { items: ManifestItem[] }, alreadyMigrated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const current = await readMemoryManifest(stackHome);
  const manifest = current ?? { schemaVersion: 1 as const, provider: 'claude' as const, createdAt: new Date().toISOString(), items: [] };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { manifest, alreadyMigrated: false };
};

type TaggedItem = { item: ManifestItem; project: ProjectIdentity };
type IdentitySubgroup = { identity: ProjectIdentity; items: ManifestItem[] };

/**
 * Build the per-canonical-path identity subgroups that `buildCanonicalMain` turns
 * into documents. Items are grouped by canonical path FIRST (not by resolved
 * Project ID) because a path collision is exactly how the upgrade spec's "old
 * duplicates" case shows up: "the same memory stored under several old folder
 * keys, left over from earlier bugs" (design doc section 9.1.3) — a single real
 * local (non-Git) project whose Claude-vendor folder key changed over time (see
 * also section 2: moving/re-cloning a project needed special fixes to avoid
 * duplicates). Those items carry DIFFERENT `local` identities (different
 * `vendorKey`s) yet are, in substance, duplicate captures of the same document and
 * must be coalesced into one project with "keep both" naming.
 *
 * A `git` identity is strong and is NEVER coalesced with anything else at the same
 * path — two different real Git-identified projects coincidentally sharing a
 * relative path (e.g. both having a `MEMORY.md`) are unrelated documents in
 * unrelated projects, not a duplicate-folder-key artifact, and merging their
 * content into one project would be a correctness bug, not a migration fix.
 */
const groupLegacyItemsByPath = (
  items: ManifestItem[],
): Map<string, IdentitySubgroup[]> => {
  const byPath = new Map<string, TaggedItem[]>();
  for (const item of items) {
    if (item.scope !== 'project' || !item.project) continue; // global stays in v1
    const canonicalPath = claudeCanonicalPathOf(item);
    if (!canonicalPath) continue;
    const bucket = byPath.get(canonicalPath) ?? [];
    bucket.push({ item, project: item.project });
    byPath.set(canonicalPath, bucket);
  }

  const subgroupsByPath = new Map<string, IdentitySubgroup[]>();
  for (const [canonicalPath, tagged] of byPath) {
    const subgroups: IdentitySubgroup[] = [];
    const localGroup: ManifestItem[] = [];
    for (const { item, project } of tagged) {
      if (project.kind === 'git') {
        const existing = subgroups.find(
          (group) =>
            group.identity.kind === 'git' &&
            group.identity.canonical.toLowerCase() === project.canonical.toLowerCase(),
        );
        if (existing) existing.items.push(item);
        else subgroups.push({ identity: project, items: [item] });
      } else {
        localGroup.push(item);
      }
    }
    if (localGroup.length > 0) {
      // The most recently captured item's identity resolves/mints the coalesced
      // project (the spec: "the most recently captured one keeping the original
      // name").
      const primary = [...localGroup].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : -1,
      )[0]!;
      subgroups.push({ identity: primary.project!, items: localGroup });
    }
    subgroupsByPath.set(canonicalPath, subgroups);
  }
  return subgroupsByPath;
};

/** Step B: build canonical documents from the backed-up v1 items, resolving/minting
 * Project IDs through the existing registry and persisting any newly minted ones. */
const buildCanonicalMain = async (
  stackHome: string,
  items: ManifestItem[],
): Promise<{ main: CanonicalMainManifest; keptBothDuplicates: number }> => {
  let registry = await readLocalRegistry(stackHome);
  const subgroupsByPath = groupLegacyItemsByPath(items);

  let keptBothDuplicates = 0;
  const documentsByProject = new Map<string, CanonicalDoc[]>();
  const takenPathsByProject = new Map<string, Set<string>>();
  for (const [canonicalPath, subgroups] of subgroupsByPath) {
    for (const subgroup of subgroups) {
      const { registry: next, projectId } = resolveOrMintProject(registry, subgroup.identity);
      registry = next;
      const documents = documentsByProject.get(projectId) ?? [];
      const takenPaths = takenPathsByProject.get(projectId) ?? new Set<string>();
      takenPaths.add(canonicalPath);

      const bucket = subgroup.items;
      const distinctHashes = new Set(bucket.map((entry) => entry.contentHash));
      if (distinctHashes.size === 1) {
        const winner = bucket[0]!;
        documents.push({
          path: canonicalPath,
          state: 'present',
          contentHash: winner.contentHash,
          importedFrom: 'claude',
          importedAt: winner.capturedAt,
        });
      } else {
        const sorted = [...bucket].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
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
      documentsByProject.set(projectId, documents);
      takenPathsByProject.set(projectId, takenPaths);
    }
  }
  await writeLocalRegistry(stackHome, registry);

  const main: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
  for (const [projectId, documents] of documentsByProject) main.projects.push({ projectId, documents });
  return { main, keptBothDuplicates };
};

/** Step C: seed the claude projection so every migrated document reads as
 * already synced (P = C), turning later native edits into ordinary edits rather
 * than a wall of first-sighting conflicts. Always recomputed from `main` and
 * rewritten, which makes it safe to resume after a crash at any point. */
const seedClaudeProjection = async (stackHome: string, main: CanonicalMainManifest) => {
  const projects: Record<string, Record<string, string>> = {};
  for (const project of main.projects) {
    const byPath: Record<string, string> = {};
    for (const doc of project.documents) if (doc.state === 'present') byPath[doc.path] = doc.contentHash;
    if (Object.keys(byPath).length > 0) projects[project.projectId] = byPath;
  }
  await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects });
};

/** Step D: slim the v1 manifest down to global-only items. Safe to re-run. */
const slimToGlobal = async (stackHome: string, items: ManifestItem[]) => {
  const globalItems = items.filter((item) => item.scope === 'global');
  await writeMemoryManifest({
    stackHome,
    manifest: { schemaVersion: 1, provider: 'claude', createdAt: new Date().toISOString(), items: globalItems },
  });
};

/**
 * Migrate the local v1 Memory store into the v2 canonical store. Each step is
 * written to be a safe no-op when it already ran, so calling this again after a
 * crash at ANY point (including mid-step) always converges on the same result —
 * there is no separate "resume" algorithm, only idempotent steps run in order.
 */
export const migrateLocalStore = async (stackHome: string): Promise<MigrationSummary> => {
  const { manifest, alreadyMigrated } = await ensureBackup(stackHome);
  for (const item of manifest.items) {
    try {
      await readMemoryObject({ stackHome, contentHash: item.contentHash });
    } catch (error) {
      throw new MigrationError(
        'migration-invalid',
        `Memory migration found a broken entry: content for "${item.logicalId}" is missing from the store.`,
        { cause: error },
      );
    }
  }
  const existingMain = await readCanonicalMain(stackHome);
  const needsBuild =
    existingMain.projects.length === 0 && manifest.items.some((i: ManifestItem) => i.scope === 'project');
  const { main, keptBothDuplicates } = needsBuild
    ? await buildCanonicalMain(stackHome, manifest.items)
    : { main: existingMain, keptBothDuplicates: 0 };
  if (needsBuild) await writeCanonicalMain(stackHome, main);
  await seedClaudeProjection(stackHome, main);
  await slimToGlobal(stackHome, manifest.items);
  const migratedDocuments = main.projects.reduce((n, p) => n + p.documents.length, 0);
  return { migratedDocuments, keptBothDuplicates, alreadyMigrated };
};

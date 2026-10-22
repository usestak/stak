import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { memoryManifestSchema, type ManifestItem } from '../domain.js';
import { memoryStorePaths, readMemoryManifest, readMemoryObject, writeMemoryManifest } from '../store.js';
import { readLocalRegistry, writeLocalRegistry } from '../project/registry-store.js';
import { resolveOrMintProject } from '../project/registry.js';
import { groupLegacyItems } from './group-legacy-items.js';
import type { CanonicalMainManifest } from './domain.js';
import { readCanonicalMain, writeCanonicalMain, writeProjection } from './store.js';

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

// A dedicated completion marker — NOT just "the backup exists" and NOT just
// "main.json has projects". Both of those are ambiguous: the backup is written
// BEFORE the build step, and an account with zero project memory ever (global
// items only, or genuinely nothing) never populates `main.json` either way, yet
// steps C/D still must run exactly once. Only this marker, written at the very
// end after every step has actually succeeded, can tell "never finished" apart
// from "finished, nothing to migrate" apart from "finished, with real content" —
// and only it is safe to gate re-running steps C/D on without either re-running
// them forever (reverting newer global backups, resetting the projection) or
// skipping a genuine crash-resume.
const migrationCompleteMarkerPath = (stackHome: string) =>
  path.join(memoryStorePaths(stackHome).manifests, '.v1-migration-complete');

const markerExists = async (file: string): Promise<boolean> => {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Step A: write the pre-migration backup exactly once. A pre-existing backup is
 * read back unchanged (never overwritten), which is what makes later steps safe
 * to resume from after any crash. Schema-validated on read-back so a truncated
 * write (crash mid-write) is caught explicitly rather than surfacing as an
 * opaque `JSON.parse` failure on every future run. */
const ensureBackup = async (stackHome: string) => {
  const dir = memoryStorePaths(stackHome).manifests;
  const file = premigrationBackupPath(stackHome);
  await mkdir(dir, { recursive: true }); // a genuinely fresh $STAK_HOME has no manifests/ yet
  try {
    const raw = await readFile(file, 'utf8');
    return { manifest: memoryManifestSchema.parse(JSON.parse(raw)), alreadyMigrated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const current = await readMemoryManifest(stackHome);
  const manifest = current ?? { schemaVersion: 1 as const, provider: 'claude' as const, createdAt: new Date().toISOString(), items: [] };
  // Write to a temp file, then publish with `link` (not `rename`): `link` fails
  // with EEXIST if `file` already exists instead of silently overwriting it, so
  // two concurrent first-ever migration attempts (e.g. two terminal windows)
  // can never both "win" and clobber each other's backup — the loser's EEXIST
  // falls back to reading the winner's already-published backup, same as the
  // ordinary "already exists" path above. (A full cross-process store lock is
  // a larger fix deferred to a later task; this is the narrow, cheap piece of
  // it specific to this one file.)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raw = await readFile(file, 'utf8');
      return { manifest: memoryManifestSchema.parse(JSON.parse(raw)), alreadyMigrated: true };
    }
    throw error;
  }
  await unlink(temp).catch(() => undefined); // link() leaves the temp name too; drop it
  return { manifest, alreadyMigrated: false };
};

/** Step B: build canonical documents from the backed-up v1 items, resolving/minting
 * Project IDs through the existing registry and persisting any newly minted ones.
 * Grouped by ALREADY-RESOLVED Project ID first, THEN by canonical path — never
 * the reverse. Path alone is never a strong identity signal anywhere else in this
 * system, and it must not become one here: two different local (non-Git)
 * projects can easily share a relative path (every Claude auto-memory project has
 * a `MEMORY.md`), and grouping by path first would silently fold one project's
 * memory into another's as a "duplicate". Grouping by resolved identity first
 * means a duplicate can only ever arise from the SAME proven identity (most
 * commonly: the same Git remote) having been captured more than once with
 * different content — the one case migration can safely and automatically
 * resolve with keep-both naming. A purely local project whose vendor key changed
 * over time (no Git remote ever) is NOT automatically reconciled by migration —
 * it becomes two separate logical projects, which is the safe, conservative
 * outcome; `stak project map` remains available to merge them manually later. */
const buildCanonicalMain = async (
  stackHome: string,
  items: ManifestItem[],
): Promise<{ main: CanonicalMainManifest; keptBothDuplicates: number }> => {
  let registry = await readLocalRegistry(stackHome);
  const tagged: Array<ManifestItem & { __projectId: string }> = [];
  for (const item of items) {
    if (item.scope !== 'project' || !item.project) continue;
    const { registry: next, projectId } = resolveOrMintProject(registry, item.project);
    registry = next;
    tagged.push({ ...item, __projectId: projectId });
  }
  await writeLocalRegistry(stackHome, registry);
  const { main, keptBothDuplicates } = groupLegacyItems(tagged);
  return { main, keptBothDuplicates };
};

/** Step C: seed the claude projection so every migrated document reads as
 * already synced (P = C), turning later native edits into ordinary edits rather
 * than a wall of first-sighting conflicts. */
const seedClaudeProjection = async (stackHome: string, main: CanonicalMainManifest) => {
  const projects: Record<string, Record<string, string>> = {};
  for (const project of main.projects) {
    const byPath: Record<string, string> = {};
    for (const doc of project.documents)
      if (doc.state === 'present') byPath[doc.path] = doc.contentHash;
    if (Object.keys(byPath).length > 0) projects[project.projectId] = byPath;
  }
  await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects });
};

/** Step D: slim the v1 manifest down to global-only items. */
const slimToGlobal = async (stackHome: string, items: ManifestItem[]) => {
  const globalItems = items.filter((item) => item.scope === 'global');
  await writeMemoryManifest({
    stackHome,
    manifest: { schemaVersion: 1, provider: 'claude', createdAt: new Date().toISOString(), items: globalItems },
  });
};

/**
 * Migrate the local v1 Memory store into the v2 canonical store. Steps A/B are
 * each independently safe to re-run (the backup is write-once; the build is
 * gated on canonical main still being empty), which is what makes a crash
 * BEFORE migration finishes resumable with no separate "resume" algorithm.
 * Steps C/D are different: once migration has genuinely finished, they must
 * NEVER run again — re-seeding the projection would erase progress any later
 * sync made, and re-slimming `current.json` would revert any global backup made
 * since. The completion marker (written only at the very end, after everything
 * else has already succeeded) is what tells "still resuming" apart from "already
 * done, nothing more to do here, ever again".
 */
export const migrateLocalStore = async (stackHome: string): Promise<MigrationSummary> => {
  const markerFile = migrationCompleteMarkerPath(stackHome);
  if (await markerExists(markerFile)) {
    const main = await readCanonicalMain(stackHome);
    return {
      migratedDocuments: main.projects.reduce((n, p) => n + p.documents.length, 0),
      keptBothDuplicates: 0,
      alreadyMigrated: true,
    };
  }

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
  const needsBuild = existingMain.projects.length === 0 && manifest.items.some((i: ManifestItem) => i.scope === 'project');
  const { main, keptBothDuplicates } = needsBuild
    ? await buildCanonicalMain(stackHome, manifest.items)
    : { main: existingMain, keptBothDuplicates: 0 };
  if (needsBuild) await writeCanonicalMain(stackHome, main);
  await seedClaudeProjection(stackHome, main);
  await slimToGlobal(stackHome, manifest.items);
  await writeFile(markerFile, new Date().toISOString(), { mode: 0o600 });

  const migratedDocuments = main.projects.reduce((n, p) => n + p.documents.length, 0);
  return { migratedDocuments, keptBothDuplicates, alreadyMigrated };
};

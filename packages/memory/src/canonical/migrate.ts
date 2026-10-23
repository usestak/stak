import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { memoryManifestSchema, type ManifestItem, type MemoryManifest } from '../domain.js';
import { hashBytes, memoryStorePaths, readMemoryManifest, readMemoryObject, writeMemoryManifest } from '../store.js';
import { readLocalRecoveryState, v1ManifestFingerprint } from '../local-recovery-state.js';
import { readLocalRegistry, writeLocalRegistry } from '../project/registry-store.js';
import { resolveOrMintProject } from '../project/registry.js';
import { claudeCanonicalPathOf, claudeNativeTargetOf } from './claude-project-adapter.js';
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

/** Read-only: has `migrateLocalStore` ever completed for this store? Callers that
 * must behave differently before vs. after migration (e.g. a status check that
 * would otherwise plan against a canonical store that migration hasn't populated
 * yet) use this to detect "upgrade pending" WITHOUT triggering it themselves. */
export const isLocalStoreMigrated = async (stackHome: string): Promise<boolean> =>
  markerExists(migrationCompleteMarkerPath(stackHome));

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
    // Skip items with no mappable canonical path BEFORE minting/resolving a
    // Project ID — never mint a registry entry for an item that will never
    // produce a document. Order matters: a malformed/edge-case v1 item
    // (`scope: 'project'` paired with a `kind` that maps to no canonical path,
    // e.g. `user-instructions`) must never leave a phantom, document-less
    // project behind in the registry or in `main.json`.
    if (!claudeCanonicalPathOf(item)) continue;
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
/** Does the native Claude file for this exact (project, path, expected hash)
 * currently exist on disk with EXACTLY that content? Any failure to read
 * (missing file, no native mapping for this path, permission error) is
 * treated as "no" — never seed a path we can't positively confirm. */
const nativeFileMatches = async (
  projectDir: string,
  projectId: string,
  canonicalPath: string,
  expectedHash: string,
  claudeHome: string | undefined,
): Promise<boolean> => {
  try {
    const target = claudeNativeTargetOf({ projectId, dir: projectDir }, canonicalPath, claudeHome);
    const bytes = await readFile(target);
    return hashBytes(bytes) === expectedHash;
  } catch {
    return false;
  }
};

/**
 * Where did the v1 manifest being migrated come from? (Task 13 fix round 3.)
 *
 *  - `'cloud-recover'`: a Cloud recover on THIS CLI restored exactly this
 *    manifest and nothing was staged locally since — proven by
 *    `local-recovery-state.json`'s `recoveredManifestFingerprint` (written only
 *    by recover, cleared by every push) matching this manifest's fingerprint.
 *    This machine's native files may never have held these documents.
 *  - `'local'`: anything else — produced by `stak add` / a local backup on this
 *    machine, which scanned these documents FROM this machine's native files.
 *    (A recover done by an older CLI recorded no fingerprint and is also read
 *    as `'local'`; see the Task 13 report, fix round 3, for this residual.)
 */
const v1ManifestOrigin = async (
  stackHome: string,
  manifest: MemoryManifest,
): Promise<'local' | 'cloud-recover'> => {
  const provenance = await readLocalRecoveryState(stackHome).catch(() => null);
  const recorded = provenance?.recoveredManifestFingerprint;
  return recorded !== undefined && recorded === v1ManifestFingerprint(manifest) ? 'cloud-recover' : 'local';
};

/**
 * Step C: seed the claude projection (spec §9.1 step 4: "mark everything as
 * last synced, so edits you made since your last `stak add` show up as normal
 * changes, not as a wall of conflicts").
 *
 *  - `origin: 'local'` — the manifest was scanned from THIS machine's native
 *    files, so P = C for every present document. A native file edited since
 *    then is an ordinary import-edit; a native file deleted since then is an
 *    ordinary import-delete (never re-materialized).
 *  - `origin: 'cloud-recover'` — seed a path ONLY when its native file exists
 *    on disk right now with exactly that content (Task 13 fix round 2,
 *    finding 5). Seeding P = C for a document this fresh machine never held
 *    would read as "deleted since sync" (`import-delete`) instead of being
 *    materialized. `locateProjectDir` resolves a project's CURRENT directory
 *    and is called AFTER the build step, so projects whose IDs were minted
 *    during migration are covered; an unlocatable project seeds nothing.
 */
const seedClaudeProjection = async (
  stackHome: string,
  main: CanonicalMainManifest,
  origin: 'local' | 'cloud-recover',
  options: {
    locateProjectDir?: (projectId: string) => Promise<string | undefined>;
    claudeHome?: string;
  } = {},
) => {
  const projects: Record<string, Record<string, string>> = {};
  for (const project of main.projects) {
    const byPath: Record<string, string> = {};
    if (origin === 'local') {
      for (const doc of project.documents) if (doc.state === 'present') byPath[doc.path] = doc.contentHash;
    } else {
      const dir = options.locateProjectDir ? await options.locateProjectDir(project.projectId) : undefined;
      if (!dir) continue; // can't resolve a directory -> can't confirm native presence -> seed nothing
      for (const doc of project.documents) {
        if (doc.state !== 'present') continue;
        if (await nativeFileMatches(dir, project.projectId, doc.path, doc.contentHash, options.claudeHome))
          byPath[doc.path] = doc.contentHash;
      }
    }
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
export const migrateLocalStore = async (
  stackHome: string,
  options: {
    /** Resolve a project's CURRENT directory (binding, discovery — whatever
     * the CLI layer already uses), for `seedClaudeProjection`'s native-file
     * existence check — used only when the migrated manifest came from a
     * Cloud recover. Called after the build step (so freshly minted Project
     * IDs resolve) and only when migration actually runs. Read-only. Omitted
     * means "can't resolve any directory": nothing is seeded for a recovered
     * manifest, and `planSync`'s first-sighting rules take over. */
    locateProjectDir?: (projectId: string) => Promise<string | undefined>;
    claudeHome?: string;
  } = {},
): Promise<MigrationSummary> => {
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
  // Seed by where the migrated v1 manifest came from (see `v1ManifestOrigin`
  // and `seedClaudeProjection`): a locally produced manifest marks everything
  // as last synced (spec §9.1 step 4); one restored by a Cloud recover seeds
  // only what this machine's native files demonstrably hold.
  await seedClaudeProjection(stackHome, main, await v1ManifestOrigin(stackHome, manifest), options);
  await slimToGlobal(stackHome, manifest.items);
  await writeFile(markerFile, new Date().toISOString(), { mode: 0o600 });

  const migratedDocuments = main.projects.reduce((n, p) => n + p.documents.length, 0);
  return { migratedDocuments, keptBothDuplicates, alreadyMigrated };
};

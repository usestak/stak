import { readFile } from 'node:fs/promises';

import type { ClaudeProjectInput } from './claude-adapter.js';
import {
  toManifestItem,
  type DiscoveredMemoryItem,
  type ManifestItem,
  type MemoryManifest,
} from './domain.js';
import { projectIdentityKey } from './project-identity.js';
import type { LocalRegistry } from './project/registry.js';
import { planMemoryRestore } from './restore.js';
import {
  hashBytes,
  readMemoryManifest,
  readMemoryObject,
  writeMemoryManifest,
  writeMemoryObject,
} from './store.js';

export type BackupPlan = {
  provider: 'claude';
  files: number;
  projects: number;
};

export type BackupResult = BackupPlan & { createdAt: string };

/** Distinct logical projects among project-scoped items (files never count as projects). */
const distinctProjectKeys = (
  items: Array<Pick<ManifestItem, 'scope' | 'project'>>,
): Set<string> =>
  new Set(
    items.flatMap((item) =>
      item.scope === 'project' && item.project
        ? [projectIdentityKey(item.project)]
        : [],
    ),
  );

const distinctProjects = (
  items: Array<Pick<ManifestItem, 'scope' | 'project'>>,
): number => distinctProjectKeys(items).size;

/** Summarize what a backup would capture (no writes). */
export const planMemoryBackup = (
  items: DiscoveredMemoryItem[],
): BackupPlan => ({
  provider: 'claude',
  files: items.length,
  projects: distinctProjects(items),
});

/* -------------------------------------------------------------------------- */
/* Continuity composition (Phase 15B.3)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The composed shape of the NEXT backup: the current native scan PLUS previously
 * backed-up Memory whose project is unresolved/unavailable on THIS machine, carried
 * forward unchanged. This exists so a new generation never silently drops Memory just
 * because its project is not checked out here. Absence from the native scan is NOT
 * treated as deletion for unresolved projects.
 */
export type BackupComposition = {
  provider: 'claude';
  native: DiscoveredMemoryItem[];
  carriedForward: ManifestItem[];
  nativeFiles: number;
  nativeProjects: number;
  retainedFiles: number;
  retainedProjects: number;
  finalFiles: number;
  finalProjects: number;
};

/**
 * Plan the next backup's composition WITHOUT writing anything. Carry-forward is
 * selected by the SAME authority restore uses: a previous item is retained only when
 * its project resolves as `project-not-found` or `identity-conflict` on this machine
 * (i.e. no available/bound destination). Items whose project IS available are covered
 * by the fresh native scan (current native versions win), matching the existing model;
 * this patch adds no new deletion semantics for available projects. Read-only: it never
 * mints Project IDs, writes the store, or touches the registry.
 */
export const planMemoryBackupComposition = async (options: {
  stackHome: string;
  nativeItems: DiscoveredMemoryItem[];
  claudeHome?: string;
  projects?: ClaudeProjectInput[];
  registry?: LocalRegistry;
}): Promise<BackupComposition> => {
  const nativeIds = new Set(options.nativeItems.map((item) => item.logicalId));
  const previous = await readMemoryManifest(options.stackHome);
  let carriedForward: ManifestItem[] = [];
  if (previous) {
    // Classify the PREVIOUS (still-current) manifest against this machine.
    const plan = await planMemoryRestore({
      stackHome: options.stackHome,
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
    });
    const unresolved = new Set(
      plan.items
        .filter(
          (item) =>
            item.status === 'project-not-found' ||
            item.status === 'identity-conflict',
        )
        .map((item) => item.logicalId),
    );
    carriedForward = previous.items.filter(
      (item) =>
        unresolved.has(item.logicalId) && !nativeIds.has(item.logicalId),
    );
  }
  const finalItems = [...options.nativeItems, ...carriedForward];
  return {
    provider: 'claude',
    native: options.nativeItems,
    carriedForward,
    nativeFiles: options.nativeItems.length,
    nativeProjects: distinctProjects(options.nativeItems),
    retainedFiles: carriedForward.length,
    retainedProjects: distinctProjects(carriedForward),
    finalFiles: finalItems.length,
    finalProjects: distinctProjects(finalItems),
  };
};

/**
 * Copy allowlisted memory into the private store, then commit the manifest LAST.
 * Read-only against native state: files are only read, never modified. If any
 * object fails to store, the manifest is not committed and the previous backup
 * remains valid (content-addressed objects are idempotent, so partial writes are
 * harmless orphans).
 *
 * `carryForward` items (Phase 15B.3) are previous manifest items whose project is
 * unavailable on this machine; they are retained UNCHANGED (their bytes are already
 * in the content-addressed store). Their objects are re-verified as present and
 * committing FAILS CLOSED if any is missing, so a backup never silently drops
 * unresolved Memory.
 */
export const runMemoryBackup = async (options: {
  stackHome: string;
  items: DiscoveredMemoryItem[];
  carryForward?: ManifestItem[];
  now?: () => Date;
}): Promise<BackupResult> => {
  const now = options.now ?? (() => new Date());
  const manifestItems: ManifestItem[] = [];
  const seen = new Set<string>();
  for (const item of options.items) {
    // Re-read at backup time; the freshly read bytes are authoritative.
    const bytes = await readFile(item.source.path);
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({
      stackHome: options.stackHome,
      contentHash,
      bytes,
    });
    const manifestItem = toManifestItem({ ...item, contentHash });
    manifestItems.push(manifestItem);
    seen.add(manifestItem.logicalId);
  }
  // Carry forward retained unavailable-project Memory, unchanged. Native wins on id.
  for (const item of options.carryForward ?? []) {
    if (seen.has(item.logicalId)) continue;
    // Fail closed: never commit a manifest that references missing bytes.
    await readMemoryObject({
      stackHome: options.stackHome,
      contentHash: item.contentHash,
    });
    manifestItems.push(item);
    seen.add(item.logicalId);
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: now().toISOString(),
    items: manifestItems,
  };
  // Commit point.
  await writeMemoryManifest({ stackHome: options.stackHome, manifest });
  return {
    provider: 'claude',
    files: manifestItems.length,
    projects: distinctProjects(manifestItems),
    createdAt: manifest.createdAt,
  };
};

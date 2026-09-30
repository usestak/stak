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
 * The composed shape of the NEXT backup (Phase 15C.1, preservation-first): the current
 * private Memory manifest is the BASELINE; the native scan is an OVERLAY. Every previous
 * item not observed in the native scan is retained UNCHANGED — regardless of whether its
 * project is available, mapped, Git-resolved, active, or archived — so a new backup never
 * silently drops Memory. Native absence is NEVER treated as deletion (see the invariant
 * in `docs/memory.md`).
 *
 * `carriedForward` holds the retained baseline items (those not present natively).
 * `retainedAvailableFiles` / `retainedUnavailableFiles` split them by whether the project
 * resolves on this machine — for the preview only; both are always preserved. Native
 * items win by logical id when the same id also appears in the baseline.
 */
export type BackupComposition = {
  provider: 'claude';
  native: DiscoveredMemoryItem[];
  carriedForward: ManifestItem[];
  nativeFiles: number;
  nativeProjects: number;
  /** Distinct projects available (resolvable) on this machine — NOT "projects with native Memory". */
  availableProjects: number;
  retainedFiles: number;
  retainedProjects: number;
  /** Retained items whose project IS available here but was not observed natively. */
  retainedAvailableFiles: number;
  /** Distinct available projects among the available retained items. */
  retainedAvailableProjects: number;
  /** Retained items whose project is unavailable/unresolved on this machine. */
  retainedUnavailableFiles: number;
  /** Distinct unavailable projects among the unavailable retained items. */
  retainedUnavailableProjects: number;
  finalFiles: number;
  finalProjects: number;
};

/**
 * Plan the next backup's composition WITHOUT writing anything. Preservation-first: the
 * private manifest is the baseline and the native scan overlays it by logical Memory
 * identity. A previous item is retained whenever it is not observed in the native scan —
 * availability and lifecycle do NOT gate retention; they only categorize it in the
 * preview. The restore plan is consulted solely to tell "available here" apart from
 * "unavailable here" for the preview wording. Read-only: it never mints Project IDs,
 * writes the store, or touches the registry.
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
  let unresolvedIds = new Set<string>();
  // Distinct projects available on this machine: any project with native Memory, plus
  // any baseline project that resolves to a destination here (available but not yet
  // restored natively). This is intentionally NOT "projects with native Memory".
  const availableProjectKeys = new Set<string>();
  const addProjectKeys = (
    items: Array<Pick<ManifestItem, 'scope' | 'project'>>,
  ): void => {
    for (const item of items)
      if (item.scope === 'project' && item.project)
        availableProjectKeys.add(projectIdentityKey(item.project));
  };
  addProjectKeys(options.nativeItems);
  if (previous) {
    // Classify the PREVIOUS (still-current) manifest against this machine — only to
    // categorize retained Memory for the preview, NOT to gate retention.
    const plan = await planMemoryRestore({
      stackHome: options.stackHome,
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
    });
    unresolvedIds = new Set(
      plan.items
        .filter(
          (item) =>
            item.status === 'project-not-found' ||
            item.status === 'identity-conflict',
        )
        .map((item) => item.logicalId),
    );
    addProjectKeys(
      plan.items.filter((item) => !unresolvedIds.has(item.logicalId)),
    );
    // Preservation-first: retain EVERY previous item not present natively.
    carriedForward = previous.items.filter(
      (item) => !nativeIds.has(item.logicalId),
    );
  }
  const retainedUnavailable = carriedForward.filter((item) =>
    unresolvedIds.has(item.logicalId),
  );
  const retainedAvailable = carriedForward.filter(
    (item) => !unresolvedIds.has(item.logicalId),
  );
  const finalItems = [...options.nativeItems, ...carriedForward];
  return {
    provider: 'claude',
    native: options.nativeItems,
    carriedForward,
    nativeFiles: options.nativeItems.length,
    nativeProjects: distinctProjects(options.nativeItems),
    availableProjects: availableProjectKeys.size,
    retainedFiles: carriedForward.length,
    retainedProjects: distinctProjects(carriedForward),
    retainedAvailableFiles: retainedAvailable.length,
    retainedAvailableProjects: distinctProjects(retainedAvailable),
    retainedUnavailableFiles: retainedUnavailable.length,
    retainedUnavailableProjects: distinctProjects(retainedUnavailable),
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
 * `carryForward` items (Phase 15C.1, preservation-first) are previous manifest items
 * NOT observed in this native scan — retained UNCHANGED regardless of availability or
 * lifecycle (their bytes are already in the content-addressed store). Native items win
 * by logical id (`seen`). Each retained object is re-verified as present and committing
 * FAILS CLOSED if any is missing, so a backup never silently drops Memory that was
 * merely absent from the native scan (absence is not deletion).
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

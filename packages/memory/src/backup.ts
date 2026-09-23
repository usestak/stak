import { readFile } from 'node:fs/promises';

import {
  toManifestItem,
  type DiscoveredMemoryItem,
  type MemoryManifest,
} from './domain.js';
import { projectIdentityKey } from './project-identity.js';
import { hashBytes, writeMemoryManifest, writeMemoryObject } from './store.js';

export type BackupPlan = {
  provider: 'claude';
  files: number;
  projects: number;
};

export type BackupResult = BackupPlan & { createdAt: string };

const distinctProjects = (items: DiscoveredMemoryItem[]): number =>
  new Set(
    items.flatMap((item) =>
      item.scope === 'project' && item.project
        ? [projectIdentityKey(item.project)]
        : [],
    ),
  ).size;

/** Summarize what a backup would capture (no writes). */
export const planMemoryBackup = (
  items: DiscoveredMemoryItem[],
): BackupPlan => ({
  provider: 'claude',
  files: items.length,
  projects: distinctProjects(items),
});

/**
 * Copy allowlisted memory into the private store, then commit the manifest LAST.
 * Read-only against native state: files are only read, never modified. If any
 * object fails to store, the manifest is not committed and the previous backup
 * remains valid (content-addressed objects are idempotent, so partial writes are
 * harmless orphans).
 */
export const runMemoryBackup = async (options: {
  stackHome: string;
  items: DiscoveredMemoryItem[];
  now?: () => Date;
}): Promise<BackupResult> => {
  const now = options.now ?? (() => new Date());
  const manifestItems = [];
  for (const item of options.items) {
    // Re-read at backup time; the freshly read bytes are authoritative.
    const bytes = await readFile(item.source.path);
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({
      stackHome: options.stackHome,
      contentHash,
      bytes,
    });
    manifestItems.push(toManifestItem({ ...item, contentHash }));
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
    projects: distinctProjects(options.items),
    createdAt: manifest.createdAt,
  };
};

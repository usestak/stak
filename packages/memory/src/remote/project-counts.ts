import { parseBundle } from './bundle-codec.js';
import { memoryManifestSchema } from '../domain.js';
import { canonicalMainManifestSchema } from '../canonical/domain.js';
import {
  claimKey,
  identityClaim,
  portableRegistrySnapshotSchema,
} from '../project/registry.js';

export type ProjectFileCount = { projectId: string; fileCount: number };

/**
 * Derive per-project file counts from a STANDARD backup bundle's bytes (P3). The Cloud may read
 * a Standard payload to deliver the product; this groups the manifest's project-scoped items by
 * their stable Project ID using the portable registry snapshot embedded in the bundle. It
 * exposes ONLY aggregate counts — never a Memory body, a path, or a project name. Any malformed
 * or registry-less bundle yields `null` (fail safe, no content leak); never used for Protected
 * (that payload is ciphertext and must never be parsed here).
 */
export const standardProjectCountsFromBundle = (
  bytes: Uint8Array,
): ProjectFileCount[] | null => {
  try {
    const bundle = parseBundle(bytes);
    // v2: the canonical Project Memory manifest already groups documents by stable Project ID.
    if (bundle.canonicalB64) {
      const main = canonicalMainManifestSchema.parse(
        JSON.parse(Buffer.from(bundle.canonicalB64, 'base64').toString('utf8')),
      );
      return main.projects
        .map((project) => ({
          projectId: project.projectId,
          fileCount: project.documents.filter((doc) => doc.state === 'present')
            .length,
        }))
        .filter((entry) => entry.fileCount > 0)
        .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
    }
    // Without the registry snapshot we cannot map item identities to stable Project IDs.
    if (!bundle.registryB64) return null;
    const snapshot = portableRegistrySnapshotSchema.parse(
      JSON.parse(Buffer.from(bundle.registryB64, 'base64').toString('utf8')),
    );
    const manifest = memoryManifestSchema.parse(
      JSON.parse(Buffer.from(bundle.manifestB64, 'base64').toString('utf8')),
    );
    const projectIdByClaim = new Map<string, string>();
    for (const project of snapshot.projects)
      for (const claim of project.claims)
        projectIdByClaim.set(claimKey(claim), project.projectId);
    const counts = new Map<string, number>();
    for (const item of manifest.items) {
      if (!item.project) continue; // global agent-memory items have no project
      const projectId = projectIdByClaim.get(
        claimKey(identityClaim(item.project)),
      );
      if (!projectId) continue;
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([projectId, fileCount]) => ({ projectId, fileCount }))
      .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
  } catch {
    // Malformed bundle/manifest/registry → fail safe; never surface content.
    return null;
  }
};

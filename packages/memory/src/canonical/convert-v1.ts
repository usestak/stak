import { memoryManifestSchema, type ManifestItem } from '../domain.js';
import { resolveProjectForIdentity, type LocalRegistry } from '../project/registry.js';
import { emptyRegistry, mergePortableSnapshot, portableRegistrySnapshotSchema } from '../project/registry.js';
import type { MemoryBackupBundle } from '../remote/bundle-codec.js';
import { groupLegacyItems } from './group-legacy-items.js';
import { emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';

/**
 * Deterministically convert a historical v1 bundle into canonical Memory. Pure:
 * depends only on the bundle's own contents, plus `localRegistry` as a fallback
 * ONLY for identities the bundle's own registry snapshot does not cover (a
 * bundle without any snapshot at all, or — in principle — a gap in one). Two
 * machines converting the SAME bundle with the SAME snapshot get the SAME
 * result regardless of their differing local registries — PROVIDED the local
 * registry does not itself claim the SAME identity under a DIFFERENT Project
 * ID than the bundle's snapshot does. In that conflicting case,
 * `resolveProjectForIdentity` returns `'conflict'` (per `registry.ts`) and the
 * affected item is silently DROPPED (fail-closed, never guessed) — so the
 * result CAN still depend on the caller's `localRegistry` even when the bundle
 * carries its own snapshot, specifically for identities the two registries
 * disagree about. Without a snapshot at all, the result depends on whichever
 * `localRegistry` is passed (spec section 9.2's documented limitation for
 * bundles predating the registry snapshot).
 */
export const convertV1Bundle = (
  bundle: MemoryBackupBundle,
  options: { localRegistry?: LocalRegistry } = {},
): CanonicalMainManifest => {
  const manifest = memoryManifestSchema.parse(
    JSON.parse(Buffer.from(bundle.manifestB64, 'base64').toString('utf8')),
  );
  let registry: LocalRegistry = options.localRegistry ?? emptyRegistry();
  if (bundle.registryB64) {
    const snapshot = portableRegistrySnapshotSchema.parse(
      JSON.parse(Buffer.from(bundle.registryB64, 'base64').toString('utf8')),
    );
    registry = mergePortableSnapshot(registry, snapshot).registry;
  }

  const tagged: Array<ManifestItem & { __projectId: string }> = [];
  for (const item of manifest.items) {
    if (item.scope !== 'project' || !item.project) continue;
    const resolution = resolveProjectForIdentity(registry, item.project);
    if (resolution.status !== 'resolved') continue; // fail closed, never guess
    tagged.push({ ...item, __projectId: resolution.projectId });
  }
  if (tagged.length === 0) return emptyCanonicalMain();
  return groupLegacyItems(tagged).main;
};

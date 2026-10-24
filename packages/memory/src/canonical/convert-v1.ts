import { memoryManifestSchema, type ManifestItem } from '../domain.js';
import { projectIdentityKey } from '../project-identity.js';
import { resolveOrMintProject, resolveProjectForIdentity, type LocalRegistry } from '../project/registry.js';
import { emptyRegistry, mergePortableSnapshot, portableRegistrySnapshotSchema } from '../project/registry.js';
import type { MemoryBackupBundle } from '../remote/bundle-codec.js';
import { claudeCanonicalPathOf } from './claude-project-adapter.js';
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

/** A v1 bundle item whose project identity matches more than one Project ID
 * (spec §10 "Upgrade can't continue"). Thrown BEFORE anything is written. */
export class V1ConversionError extends Error {
  readonly code = 'migration-invalid' as const;
  constructor(
    message: string,
    readonly conflicts: { identity: string; projectIds: string[] }[],
  ) {
    super(message);
    this.name = 'V1ConversionError';
  }
}

/**
 * `convertV1Bundle` for a recover onto an already-upgraded store (spec §8.5 /
 * §9.2): the same snapshot-first resolution, but it never drops an item. An
 * identity matching more than one Project ID throws `V1ConversionError` (fail
 * closed: the caller recovers nothing). An identity neither registry knows is
 * minted, exactly like local migration (`buildCanonicalMain`) — the returned
 * `registry` carries those new Project IDs for the caller to persist.
 */
export const convertV1BundleForRecover = (
  bundle: MemoryBackupBundle,
  options: { localRegistry: LocalRegistry; mint?: () => string },
): { main: CanonicalMainManifest; registry: LocalRegistry } => {
  const manifest = memoryManifestSchema.parse(
    JSON.parse(Buffer.from(bundle.manifestB64, 'base64').toString('utf8')),
  );
  let registry: LocalRegistry = options.localRegistry;
  if (bundle.registryB64) {
    const snapshot = portableRegistrySnapshotSchema.parse(
      JSON.parse(Buffer.from(bundle.registryB64, 'base64').toString('utf8')),
    );
    registry = mergePortableSnapshot(registry, snapshot).registry;
  }
  const tagged: Array<ManifestItem & { __projectId: string }> = [];
  const conflicts = new Map<string, string[]>();
  for (const item of manifest.items) {
    if (item.scope !== 'project' || !item.project) continue;
    // Final review T15-1: skip an item with no canonical path BEFORE resolving
    // or minting, exactly like local migration (`migrate.ts`'s
    // `buildCanonicalMain`) — never a phantom, document-less project.
    if (!claudeCanonicalPathOf(item)) continue;
    const resolution = resolveProjectForIdentity(registry, item.project);
    if (resolution.status === 'conflict') {
      conflicts.set(projectIdentityKey(item.project), resolution.projectIds);
      continue;
    }
    const resolved = resolveOrMintProject(registry, item.project, options.mint);
    registry = resolved.registry;
    tagged.push({ ...item, __projectId: resolved.projectId });
  }
  if (conflicts.size > 0)
    throw new V1ConversionError(
      `This backup uses the old Memory format, and ${conflicts.size} of its project(s) match more than one project on this machine (${[...conflicts]
        .map(([identity, ids]) => `${identity}: ${ids.join(', ')}`)
        .join('; ')}). Nothing was recovered.`,
      [...conflicts].map(([identity, projectIds]) => ({ identity, projectIds })),
    );
  return { main: tagged.length === 0 ? emptyCanonicalMain() : groupLegacyItems(tagged).main, registry };
};

import { StackCompositionError } from '@stack/core';
import {
  documentOf,
  effectiveCanonicalBase,
  emptyCanonicalMain,
  fetchRemoteCanonical,
  mergeCanonical,
  pendingMergeSchema,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRegistry,
  readPendingMerge,
  RemoteMemoryError,
  writeMemoryObject,
  type CanonicalDoc,
  type CanonicalMainManifest,
  type MergeConflict,
  type PendingMerge,
  type PortableRegistrySnapshot,
} from '@stack/memory';

import type { MemoryCloudDeps } from './cloud-ops.js';

/**
 * Task 14: the pending-merge (`canonical/merge.json`) checks shared by `stak
 * memory resolve`/`diff` (canonical-ops.ts) and the push/pull/backup paths'
 * `merge-pending` gate (canonical-ops.ts, cloud-ops.ts). Kept separate so
 * cloud-ops.ts can use it without importing canonical-ops.ts (which imports
 * cloud-ops.ts).
 */

export type MemoryResolveErrorCode =
  | 'no-pending-merge'
  | 'conflict-not-found'
  | 'project-not-found'
  | 'ambiguous-project'
  /** Spec Appendix A.6: "Project not on this machine". */
  | 'project-unbound'
  /** Cloud's side of the merge can't be read right now (signed out, locked,
   * generation gone, unreadable). Never treated as an empty Cloud. */
  | 'cloud-unavailable'
  /** Local Memory or the sync base moved since the pending merge was made. */
  | 'merge-stale';

/** Every resolve/diff/materialize refusal. Thrown BEFORE anything is written.
 * A `StackCompositionError` so the CLI prints its message plainly. */
export class MemoryResolveError extends StackCompositionError {
  constructor(code: MemoryResolveErrorCode, message: string) {
    super(code, message);
    this.name = 'MemoryResolveError';
  }
}

/** Spec Appendix A.6 `MemorySyncError`. Only `merge-pending` is raised here
 * (the other spec codes are reported through existing outcomes). */
export class MemorySyncError extends StackCompositionError {
  constructor(
    code: 'merge-pending',
    message: string,
    readonly conflicts: MergeConflict[] = [],
  ) {
    super(code, message);
    this.name = 'MemorySyncError';
  }
}

/** Spec §10 "Merge pending: Resolve the listed conflicts, then push again". */
export const mergePendingMessage = (
  conflicts: readonly { projectId: string; path: string; reason: string }[],
): string =>
  [
    `Memory merge pending: ${conflicts.length} unresolved conflict(s).`,
    ...conflicts.map((c) => `  ${c.projectId}  ${c.path}  (${c.reason})`),
    'Resolve the listed conflicts, then push again: `stak memory resolve <project> <path> --keep local|cloud|both`.',
  ].join('\n');

export const conflictKey = (projectId: string, docPath: string): string =>
  `${projectId}\u0000${docPath}`;

export const readPending = async (
  stackHome: string,
): Promise<PendingMerge | null> =>
  readPendingMerge(stackHome, pendingMergeSchema);

/**
 * Cloud's canonical Memory at EXACTLY `generation` (Task 14 C4/C5: a
 * resolution belongs to the generation its merge was made against — never
 * latest). Fails closed: signed out, Protected-and-locked, a generation that is
 * gone (retired with no Protected replica), or an unreadable one all THROW —
 * never an empty Cloud, which would turn "keep cloud" into a mass deletion.
 * A generation retired by `stak memory protect` is read from its committed
 * replica (`fetchRemoteCanonical`'s existing mapping). Bundled objects are
 * persisted so Cloud-side content can be shown and materialized.
 */
export const fetchCloudAtGeneration = async (
  deps: MemoryCloudDeps,
  generation: number,
): Promise<{
  main: CanonicalMainManifest;
  registrySnapshot: PortableRegistrySnapshot | undefined;
}> => {
  if (!deps.backend)
    throw new MemoryResolveError(
      'cloud-unavailable',
      `Not signed in. Resolving a Memory conflict needs Cloud's version (generation ${generation}). Run \`stak login\`, then try again. Nothing was changed.`,
    );
  const profile = await deps.backend.getProfile();
  const mmk =
    (await deps.localKeyStore.loadMmk().catch(() => null)) ?? undefined;
  if ((profile?.privacyMode ?? 'standard') === 'protected' && !mmk)
    throw new MemoryResolveError(
      'cloud-unavailable',
      "Protected Memory is locked on this device, so Cloud's version can't be read. Unlock it with `stak memory recover --passkey` or `stak memory recover --recovery-file <path>`. Nothing was changed.",
    );
  let result: Awaited<ReturnType<typeof fetchRemoteCanonical>>;
  try {
    result = await fetchRemoteCanonical({
      backend: deps.backend,
      ...(mmk ? { mmk } : {}),
      localRegistry: await readLocalRegistry(deps.stackHome),
      generation,
    });
  } catch (error) {
    if (error instanceof RemoteMemoryError)
      throw new MemoryResolveError(
        'cloud-unavailable',
        `Could not read Cloud's version (generation ${generation}): ${error.message} Nothing was changed.`,
      );
    throw error;
  }
  if (!result)
    throw new MemoryResolveError(
      'cloud-unavailable',
      `STAK Cloud no longer has generation ${generation}, which this merge was made against. Nothing was changed. Run \`stak push\` (or \`stak pull\`) to merge again against Cloud's current Memory.`,
    );
  for (const object of result.objects)
    await writeMemoryObject({
      stackHome: deps.stackHome,
      contentHash: object.contentHash,
      bytes: object.bytes,
    });
  return { main: result.main, registrySnapshot: result.registrySnapshot };
};

export const stableDoc = (doc: CanonicalDoc | null | undefined): string =>
  doc === undefined || doc === null
    ? 'absent'
    : JSON.stringify(
        Object.fromEntries(
          Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      );

const docsByKey = (main: CanonicalMainManifest): Map<string, CanonicalDoc> => {
  const out = new Map<string, CanonicalDoc>();
  for (const project of main.projects)
    for (const doc of project.documents)
      out.set(conflictKey(project.projectId, doc.path), doc);
  return out;
};

/**
 * Refuse to use a pending merge that no longer describes this machine. Push or
 * pull wrote `merged` from (base, local, Cloud r) at the time of the conflict;
 * if local Memory changed since (e.g. `stak add .` staged another edit) or the
 * base moved, finishing it would silently drop that newer local state. So:
 *  1. recompute the same merge and require that it still agrees with the
 *     pending one — every clean document identical, and the conflict set
 *     exactly the pending + already-resolved conflicts;
 *  2. (fix round 1) for every conflict ALREADY resolved, require that local's
 *     document at that path is still exactly the state the resolution was
 *     made against — (1) alone cannot see a later edit there, because the
 *     path is still a conflict either way.
 */
export const assertPendingMergeCurrent = async (
  deps: MemoryCloudDeps,
  pending: PendingMerge,
  local: CanonicalMainManifest,
  cloudMain: CanonicalMainManifest,
): Promise<void> => {
  const base = await effectiveCanonicalBase(
    deps.backend,
    await readCanonicalBase(deps.stackHome),
  );
  const recomputed = mergeCanonical(
    base?.main ?? emptyCanonicalMain(),
    local,
    cloudMain,
  );
  const resolved = pending.resolved ?? [];
  const expectedConflicts = new Set([
    ...pending.conflicts.map((c) => conflictKey(c.projectId, c.path)),
    ...resolved.map((r) => conflictKey(r.projectId, r.path)),
  ]);
  const actualConflicts = new Set(
    recomputed.conflicts.map((c) => conflictKey(c.projectId, c.path)),
  );
  const resolvedKeys = new Set(
    resolved.flatMap((r) => [
      conflictKey(r.projectId, r.path),
      ...(r.altPath ? [conflictKey(r.projectId, r.altPath)] : []),
    ]),
  );
  const pendingDocs = docsByKey(pending.merged);
  const recomputedDocs = docsByKey(recomputed.merged);
  const stale =
    expectedConflicts.size !== actualConflicts.size ||
    [...expectedConflicts].some((key) => !actualConflicts.has(key)) ||
    [...recomputedDocs].some(
      ([key, doc]) => stableDoc(pendingDocs.get(key)) !== stableDoc(doc),
    ) ||
    [...pendingDocs.keys()].some(
      (key) => !recomputedDocs.has(key) && !resolvedKeys.has(key),
    ) ||
    resolved.some(
      (r) =>
        r.local === undefined ||
        stableDoc(documentOf(local, r.projectId, r.path)) !==
          stableDoc(r.local),
    );
  if (stale)
    throw new MemoryResolveError(
      'merge-stale',
      'Local Memory has changed since this merge was prepared (for example by `stak add .`), so it can no longer be finished. Nothing was changed. Run `stak push` (or `stak pull`) to merge again; any conflicts you already resolved in this merge will be listed again and need resolving again.',
    );
};

/**
 * Spec A.6 / §8.2 / §10 `merge-pending` gate for push, pull and `stak memory
 * backup` (Task 14 fix round 1). Throws `MemorySyncError('merge-pending')`,
 * changing nothing (merge.json and its partial resolutions are kept), when:
 *  - a merge is pending, AND
 *  - Cloud's latest is still the generation it was made against, AND
 *  - it still describes this machine (`assertPendingMergeCurrent`).
 * Otherwise returns, and the caller re-merges exactly as before: Cloud moved
 * on (spec §8.3: old decisions are never replayed blindly), or the merge is
 * stale. Call it BEFORE anything that writes (base seeding, merging).
 */
export const assertNoCurrentPendingMerge = async (
  deps: MemoryCloudDeps,
): Promise<void> => {
  if (!deps.backend) return;
  const pending = await readPending(deps.stackHome);
  if (!pending || pending.conflicts.length === 0) return;
  const latest = await deps.backend.getLatest();
  if (!latest || latest.generation !== pending.basedOnGeneration) return;
  const cloud = await fetchCloudAtGeneration(deps, pending.basedOnGeneration);
  try {
    await assertPendingMergeCurrent(
      deps,
      pending,
      await readCanonicalMain(deps.stackHome),
      cloud.main,
    );
  } catch (error) {
    if (error instanceof MemoryResolveError && error.code === 'merge-stale')
      return;
    throw error;
  }
  throw new MemorySyncError(
    'merge-pending',
    mergePendingMessage(pending.conflicts),
    pending.conflicts,
  );
};

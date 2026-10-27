import {
  canonicalDigest,
  emptyCanonicalMain,
  type CanonicalMainManifest,
} from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';
import { pendingMergeGenerationOf, type RemoteCanonical } from './push.js';

export type PullDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  getBase(): Promise<{
    generation: number;
    main: CanonicalMainManifest;
    globalDigest?: string;
  } | null>;
  setLocalMain(main: CanonicalMainManifest): Promise<void>;
  setBase(base: {
    generation: number;
    main: CanonicalMainManifest;
    globalDigest?: string;
  }): Promise<void>;
  /** See `PushDeps.getLocalGlobalDigest` (final review I1 re-fix). */
  getLocalGlobalDigest?(): Promise<string>;
  fetchRemote(): Promise<RemoteCanonical | null>;
  savePendingMerge(pending: {
    basedOnGeneration: number;
    merged: CanonicalMainManifest;
    conflicts: MergeConflict[];
  }): Promise<void>;
  clearPendingMerge(): Promise<void>;
};

export type PullOutcome =
  | { status: 'up-to-date'; generation: number | null }
  | { status: 'merged-local'; main: CanonicalMainManifest }
  | { status: 'conflict'; conflicts: MergeConflict[] };

/**
 * Pull canonical Memory: merge in whatever Cloud has, but NEVER create a Cloud
 * generation. On a clean merge, local main advances to the merge result, and the
 * local base advances to the generation just merged against — but see the note
 * below, the base's CONTENT must be `remote.main`, never the merge result. See
 * spec section 8.4.
 *
 * The base's meaning is "what this machine last synced its content with on
 * Cloud" — it must always be exactly some real Cloud generation's actual
 * content, because every future merge compares against it as ground truth. The
 * merge result can include local-only documents that were never pushed; if the
 * base recorded THAT instead of what Cloud actually holds, a later pull or push
 * would see a base that no real Cloud generation ever had. Concretely: compare
 * the base to a later remote that still lacks that same local-only document —
 * the merge engine would read "the document existed in the base but is absent
 * from remote" as "Cloud deleted it", and silently drop it from local storage,
 * even though it was never pushed and nothing ever deleted it. (This exact
 * substitution — `main: merged` where `main: remote.main` was needed — is safe
 * in `push.ts`'s equivalent step ONLY because push's `merged` has just become
 * the genuinely-published content of that generation; pull's `merged` was never
 * published anywhere, so the same substitution is wrong here.)
 */
export const pullCanonicalMemory = async (
  deps: PullDeps,
): Promise<PullOutcome> => {
  const remote = await deps.fetchRemote();
  if (!remote) return { status: 'up-to-date', generation: null };

  const local = await deps.getLocalMain();
  const base = await deps.getBase();
  // Final review I1 (re-fix): pull never changes global Memory locally, so it
  // keeps the recorded last-synced global digest — overwriting it with the
  // local one would swallow an unpushed global edit. With no record yet, it
  // records one only when local global already equals Cloud's.
  const localGlobal = deps.getLocalGlobalDigest
    ? await deps.getLocalGlobalDigest()
    : undefined;
  const recordedGlobal =
    base?.globalDigest ??
    (localGlobal !== undefined && localGlobal === remote.globalDigest
      ? localGlobal
      : undefined);
  const withGlobal = (next: {
    generation: number;
    main: CanonicalMainManifest;
  }) =>
    recordedGlobal !== undefined
      ? { ...next, globalDigest: recordedGlobal }
      : next;

  if (canonicalDigest(remote.main) === canonicalDigest(local)) {
    // Nothing to pull. Repair a missing or stale base (a crash right after an
    // earlier sync's local writes, or a fresh machine whose local Memory
    // already happens to match Cloud) so a LATER pull or push never merges
    // against a base that no longer reflects reality.
    if (base === null || base.generation !== remote.generation)
      await deps.setBase(
        withGlobal({ generation: remote.generation, main: remote.main }),
      );
    // Task 14 fix round 1: local equals Cloud — a leftover merge.json is a phantom.
    await deps.clearPendingMerge();
    return { status: 'up-to-date', generation: remote.generation };
  }

  if (base !== null && base.generation === remote.generation) {
    // Cloud has not moved since our base; any difference from remote is purely
    // local, unpushed work — nothing new to pull. A leftover merge.json was
    // made against an older base and no longer applies (Task 14 fix round 1).
    await deps.clearPendingMerge();
    return { status: 'up-to-date', generation: remote.generation };
  }

  const baseMain = base?.main ?? emptyCanonicalMain();
  const { merged, conflicts } = mergeCanonical(baseMain, local, remote.main);
  if (conflicts.length > 0) {
    await deps.savePendingMerge({
      basedOnGeneration: pendingMergeGenerationOf(remote),
      merged,
      conflicts,
    });
    return { status: 'conflict', conflicts };
  }
  await deps.setLocalMain(merged);
  await deps.setBase(
    withGlobal({ generation: remote.generation, main: remote.main }),
  );
  await deps.clearPendingMerge();
  return { status: 'merged-local', main: merged };
};

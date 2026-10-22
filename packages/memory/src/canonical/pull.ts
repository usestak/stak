import { canonicalDigest, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';
import type { RemoteCanonical } from './push.js';

export type PullDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>;
  setLocalMain(main: CanonicalMainManifest): Promise<void>;
  setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>;
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
 * generation. On a clean merge, both local main and the local base advance (to
 * the generation just merged against) so the next `stak push` can fast-forward
 * the merge result up as an ordinary new generation. See spec section 8.4.
 */
export const pullCanonicalMemory = async (deps: PullDeps): Promise<PullOutcome> => {
  const remote = await deps.fetchRemote();
  if (!remote) return { status: 'up-to-date', generation: null };

  const local = await deps.getLocalMain();
  if (canonicalDigest(remote.main) === canonicalDigest(local))
    return { status: 'up-to-date', generation: remote.generation };

  const base = await deps.getBase();
  if (base !== null && base.generation === remote.generation)
    // Cloud has not moved since our base; any difference from remote is purely
    // local, unpushed work — nothing new to pull.
    return { status: 'up-to-date', generation: remote.generation };

  const baseMain = base?.main ?? emptyCanonicalMain();
  const { merged, conflicts } = mergeCanonical(baseMain, local, remote.main);
  if (conflicts.length > 0) {
    await deps.savePendingMerge({ basedOnGeneration: remote.generation, merged, conflicts });
    return { status: 'conflict', conflicts };
  }
  await deps.setLocalMain(merged);
  await deps.setBase({ generation: remote.generation, main: merged });
  await deps.clearPendingMerge();
  return { status: 'merged-local', main: merged };
};

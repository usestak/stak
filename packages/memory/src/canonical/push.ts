import { canonicalDigest, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';

export type RemoteCanonical = { generation: number; main: CanonicalMainManifest };

/** The shape `publish` rejects with on a concurrent-write race (duck-typed so this
 * module never imports `RemoteMemoryError` directly — matches its `code: 'conflict'`). */
export type PublishConflictError = { code: 'conflict' };

export type PushDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>;
  setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>;
  fetchRemote(): Promise<RemoteCanonical | null>;
  publish(main: CanonicalMainManifest, expectedParent: number | null): Promise<{ generation: number }>;
  savePendingMerge(pending: {
    basedOnGeneration: number;
    merged: CanonicalMainManifest;
    conflicts: MergeConflict[];
  }): Promise<void>;
  clearPendingMerge(): Promise<void>;
  maxAttempts?: number;
};

export type PushOutcome =
  | { status: 'up-to-date'; generation: number }
  | { status: 'pushed'; generation: number; main: CanonicalMainManifest }
  | { status: 'conflict'; conflicts: MergeConflict[] }
  | { status: 'retry-exhausted' };

export class PushError extends Error {
  readonly code = 'retry-exhausted' as const;

  constructor(message = 'push retry attempts exhausted') {
    super(message);
    this.name = 'PushError';
  }
}

const isConflictError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'conflict';

/**
 * Push canonical Memory: fast-forward when nothing else changed Cloud since this
 * machine's base, three-way merge when it did, and an all-or-nothing stop on any
 * real conflict. See spec section 8.2 and Appendix A.4.
 *
 * The "is Cloud already exactly what I have" check only applies OFF the
 * fast-forward path (i.e. only when base and remote generations disagree, or one
 * of base/remote is null while the other isn't). That's deliberate: it is what
 * makes a crash between a successful `publish` and the local `setBase` self-heal
 * on the next push (Cloud has moved past our stale base to exactly `local`), while
 * a genuine fast-forward attempt — base and remote generations agreeing, even if
 * local happens to already match remote's content (nothing changed locally
 * either) — still goes through `publish` rather than being short-circuited, so a
 * concurrent-write race on that publish is still detected and retried.
 */
export const pushCanonicalMemory = async (deps: PushDeps): Promise<PushOutcome> => {
  const maxAttempts = deps.maxAttempts ?? 3;
  const local = await deps.getLocalMain();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remote = await deps.fetchRemote();
    const base = await deps.getBase();

    const isFastForward =
      (base === null && remote === null) ||
      (base !== null && remote !== null && base.generation === remote.generation);

    if (!isFastForward && remote && canonicalDigest(remote.main) === canonicalDigest(local)) {
      // Cloud's latest already matches local exactly, even though our known base
      // disagrees with it (or we have no base at all) — a previous publish must
      // have succeeded on Cloud without our local bookkeeping catching up. Repair
      // the base and stop; publishing again would create a pointless duplicate
      // generation.
      await deps.setBase({ generation: remote.generation, main: local });
      return { status: 'up-to-date', generation: remote.generation };
    }

    if (isFastForward) {
      const expectedParent = remote?.generation ?? null;
      try {
        const result = await deps.publish(local, expectedParent);
        await deps.setBase({ generation: result.generation, main: local });
        return { status: 'pushed', generation: result.generation, main: local };
      } catch (error) {
        if (!isConflictError(error)) throw error; // not a race we can retry: propagate immediately
        if (attempt === maxAttempts) break;
        continue; // Cloud moved again mid-push; retry against the new latest.
      }
    }

    // Merge path: something else changed Cloud since this machine's base.
    const baseMain = base?.main ?? emptyCanonicalMain();
    const remoteGeneration = remote!.generation; // non-null: isFastForward handles the null/null case
    const { merged, conflicts } = mergeCanonical(baseMain, local, remote!.main);
    if (conflicts.length > 0) {
      await deps.savePendingMerge({ basedOnGeneration: remoteGeneration, merged, conflicts });
      return { status: 'conflict', conflicts };
    }
    try {
      const result = await deps.publish(merged, remoteGeneration);
      await deps.setBase({ generation: result.generation, main: merged });
      await deps.clearPendingMerge();
      return { status: 'pushed', generation: result.generation, main: merged };
    } catch (error) {
      if (!isConflictError(error)) throw error; // not a race we can retry: propagate immediately
      if (attempt === maxAttempts) break;
      continue;
    }
  }
  return { status: 'retry-exhausted' };
};

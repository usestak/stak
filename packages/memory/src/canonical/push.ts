import { hashBytes } from '../store.js';
import type { MemoryManifest } from '../domain.js';
import {
  canonicalDigest,
  emptyCanonicalMain,
  type CanonicalMainManifest,
} from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';

/**
 * Final review I1: a content digest of the GLOBAL Memory a v1 manifest holds
 * (spec §1: global Memory keeps working as today, carried in the bundle's v1
 * manifest). Only `scope: 'global'` items count — a pre-migration manifest's
 * project items live in canonical Memory once migrated — and the per-capture
 * timestamps (`createdAt`, `capturedAt`) are left out, so re-staging identical
 * global files never looks like a change. A missing manifest is "no global
 * Memory".
 */
export const globalManifestDigest = (
  manifest: MemoryManifest | null | undefined,
): string => {
  const items = (manifest?.items ?? [])
    .filter((item) => item.scope === 'global')
    .map((item) => ({
      provider: item.provider,
      kind: item.kind,
      scope: item.scope,
      logicalId: item.logicalId,
      project: item.project ?? null,
      contentHash: item.contentHash,
      restoreTarget: item.restoreTarget,
      sensitivity: item.sensitivity,
    }))
    .sort((a, b) =>
      a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0,
    );
  return hashBytes(Buffer.from(JSON.stringify(items), 'utf8'));
};

export type RemoteCanonical = {
  generation: number;
  main: CanonicalMainManifest;
  /** Generation the content was read from, when it differs from `generation`
   * (see `fetchRemoteCanonical`). A pending merge records this one. */
  contentGeneration?: number;
  /** `globalManifestDigest` of the global Memory this generation carries
   * (final review I1). */
  globalDigest?: string;
};

/** The generation a pending merge is "based on": the one whose content was
 * merged — fetchable again by `stak memory resolve`/`diff` (Task 14). */
export const pendingMergeGenerationOf = (remote: RemoteCanonical): number =>
  remote.contentGeneration ?? remote.generation;

/** The shape `publish` rejects with on a concurrent-write race (duck-typed so this
 * module never imports `RemoteMemoryError` directly — matches its `code: 'conflict'`). */
export type PublishConflictError = { code: 'conflict' };

export type PushDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  /** `globalManifestDigest` of this machine's staged global Memory (final
   * review I1). When provided, Cloud is only "up to date" when its
   * `globalDigest` matches too, so a global-only change is published. */
  getLocalGlobalDigest?(): Promise<string>;
  getBase(): Promise<{
    generation: number;
    main: CanonicalMainManifest;
    globalDigest?: string;
  } | null>;
  /** Called whenever a clean merge's result differs from what `getLocalMain`
   * returned — regardless of whether that result also gets published. A merge
   * can incorporate remote-only documents local never had; if that result is
   * never written to local storage, the NEXT push would re-upload the stale,
   * pre-merge local state and silently delete those documents from Cloud. */
  setLocalMain(main: CanonicalMainManifest): Promise<void>;
  setBase(base: {
    generation: number;
    main: CanonicalMainManifest;
    globalDigest?: string;
  }): Promise<void>;
  fetchRemote(): Promise<RemoteCanonical | null>;
  publish(
    main: CanonicalMainManifest,
    expectedParent: number | null,
  ): Promise<{ generation: number }>;
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
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'conflict';

/**
 * Push canonical Memory: fast-forward when nothing else changed Cloud since this
 * machine's base, three-way merge when it did, and an all-or-nothing stop on any
 * real conflict. See spec section 8.2 and Appendix A.4.
 *
 * Whether to publish depends ONLY on content — never on whether generation
 * numbers happen to agree. The very first thing every attempt checks is "is
 * Cloud's current latest already semantically identical to local", completely
 * unconditionally. This single check covers BOTH the ordinary "nothing changed
 * since my last push" case (the single most common push of all — it must never
 * create a duplicate generation) AND the crash-recovery case (a stale/disagreeing
 * base, but Cloud already has exactly `local` because an earlier publish
 * actually succeeded and only local bookkeeping didn't catch up). Generation
 * agreement decides HOW to publish if something does need publishing
 * (fast-forward vs. merge) — it never decides WHETHER to.
 */
export const pushCanonicalMemory = async (
  deps: PushDeps,
): Promise<PushOutcome> => {
  const maxAttempts = deps.maxAttempts ?? 3;
  const localGlobal = deps.getLocalGlobalDigest
    ? await deps.getLocalGlobalDigest()
    : undefined;
  // Every base this push writes records the global Memory it synced.
  const withGlobal = (next: {
    generation: number;
    main: CanonicalMainManifest;
  }) =>
    localGlobal !== undefined ? { ...next, globalDigest: localGlobal } : next;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Remote FIRST, then base and local, on EVERY attempt (spec §4.2.1 review
    // fix C1): fetching may teach this machine a project alias (the caller
    // folds local and base with the same alias map as the fetched remote), so
    // local and base are only read after it — never reused from an earlier
    // attempt's, possibly un-folded, read.
    const remote = await deps.fetchRemote();
    const base = await deps.getBase();
    const local = await deps.getLocalMain();
    // Final review I1 (re-fix): global Memory travels in the same generation
    // but is never pulled onto an established machine, so two machines can
    // legitimately hold different global files. Global needs publishing only
    // when it changed HERE since this machine's last sync (`base.globalDigest`).
    // It is in sync when it matches Cloud's OR is unchanged locally. Legacy
    // rule: a base with no recorded digest counts as unchanged — a global-only
    // difference never publishes without a record (the next sync records one).
    const globalUnchangedLocally =
      localGlobal === undefined ||
      base?.globalDigest === undefined ||
      base.globalDigest === localGlobal;
    const globalMatches = (r: RemoteCanonical): boolean =>
      globalUnchangedLocally || r.globalDigest === localGlobal;

    if (
      remote &&
      canonicalDigest(remote.main) === canonicalDigest(local) &&
      globalMatches(remote)
    ) {
      await deps.setBase(
        withGlobal({ generation: remote.generation, main: local }),
      );
      // Task 14 fix round 1: local and Cloud agree, so any leftover
      // `merge.json` (e.g. a crash after a final resolve wrote main/base but
      // before it cleared the merge) describes nothing real any more.
      await deps.clearPendingMerge();
      return { status: 'up-to-date', generation: remote.generation };
    }

    // Task 13 fix round 6: no committed Cloud generation at all (`remote ===
    // null` — never pushed, or every generation retired) is always a
    // fast-forward: re-upload local as-is, never merge against "nothing" (which
    // would read as Cloud having deleted everything). The publisher resolves
    // the parent for an emptied account from the commit counter.
    const isFastForward =
      remote === null ||
      (base !== null && base.generation === remote.generation);

    if (isFastForward) {
      const expectedParent = remote?.generation ?? null;
      try {
        const result = await deps.publish(local, expectedParent);
        await deps.setBase(
          withGlobal({ generation: result.generation, main: local }),
        );
        await deps.clearPendingMerge(); // Task 14 fix round 1: no phantom merge.json
        return { status: 'pushed', generation: result.generation, main: local };
      } catch (error) {
        if (!isConflictError(error)) throw error; // not a race we can retry: propagate immediately
        if (attempt === maxAttempts) break;
        continue; // Cloud moved again mid-push; retry against the new latest.
      }
    }

    // Merge path: something else changed Cloud since this machine's base.
    // isFastForward is true whenever remote is null, and every branch above
    // that sets isFastForward returns, retries, or re-throws — so control
    // only reaches here when isFastForward was false, which guarantees remote
    // is non-null.
    if (!remote)
      throw new Error('unreachable: merge path requires a remote generation');
    const baseMain = base?.main ?? emptyCanonicalMain();
    const remoteGeneration = remote.generation;
    const { merged, conflicts } = mergeCanonical(baseMain, local, remote.main);
    if (conflicts.length > 0) {
      // = `pendingMergeGenerationOf(remote)`: the generation the content came from.
      await deps.savePendingMerge({
        basedOnGeneration: remote?.contentGeneration ?? remoteGeneration,
        merged,
        conflicts,
      });
      return { status: 'conflict', conflicts };
    }
    if (
      canonicalDigest(merged) === canonicalDigest(remote.main) &&
      globalMatches(remote)
    ) {
      // The merge only ever picked up content remote already has; there is
      // nothing of ours to contribute. Publishing `merged` now would create a
      // generation identical to `remoteGeneration` — forbidden. This IS already
      // Cloud's committed state, so it is safe to adopt immediately: advance
      // local storage and the base together and stop.
      await deps.setLocalMain(merged);
      await deps.setBase(
        withGlobal({ generation: remoteGeneration, main: merged }),
      );
      await deps.clearPendingMerge(); // Task 14 fix round 1: no phantom merge.json
      return { status: 'up-to-date', generation: remoteGeneration };
    }
    // Do NOT adopt `merged` into local storage yet — it is not yet Cloud's
    // committed state. Adopting it before `publish` succeeds would let local
    // storage run ahead of `base` across a retry or a crash: if this exact
    // `publish` call fails or the process dies here, local storage would hold
    // `merged` while `base` still points at the OLD generation, so the next
    // merge would compare a NEW remote against a base that no longer matches
    // what is actually on disk — able to resurrect content a later remote
    // change removed, or raise a conflict that is not real. `setLocalMain` and
    // `setBase` move together, immediately after `publish` actually succeeds.
    try {
      const result = await deps.publish(merged, remoteGeneration);
      await deps.setLocalMain(merged);
      await deps.setBase(
        withGlobal({ generation: result.generation, main: merged }),
      );
      await deps.clearPendingMerge();
      return { status: 'pushed', generation: result.generation, main: merged };
    } catch (error) {
      if (!isConflictError(error)) throw error;
      if (attempt === maxAttempts) break;
      continue;
    }
  }
  return { status: 'retry-exhausted' };
};

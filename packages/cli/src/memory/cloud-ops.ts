/**
 * CLI operations for remote STAK Memory (Phase 14B). Encodes the product rules:
 *  - `backup` ALWAYS makes the safe local Phase 14A backup first, then a Cloud
 *    backup when authenticated (Standard by default, Protected when the account is
 *    Protected AND this device holds the MMK). If the account is Protected but the
 *    MMK is unavailable, the Cloud portion FAILS CLOSED — never a silent Standard
 *    fallback. Cloud failure never invalidates the local backup.
 *  - `recover` rebuilds the local private store from Cloud (Protected needs the MMK,
 *    from this device or a recovery method). It never writes native agent files.
 *  - `protect` establishes the MMK + a recovery method, enrolls this device, and
 *    migrates existing Standard backups (verify-before-delete).
 *
 * Pure and injectable (backend, local key store, local-backup runner) so it is
 * fully testable without the network. The commands layer builds the real backend
 * from the authenticated cloud client.
 */
import { readFile } from 'node:fs/promises';

import { applyRecoveredProjectNames } from './project-ops.js';
import { assertNoCurrentPendingMerge, MemorySyncError } from './pending-merge.js';
import { foldProjectMemory, type ProjectFoldNote } from './project-fold.js';
import {
  BundleError,
  foldProjectAliases,
  projectAliasResolver,
  CIPHER_VERSION,
  addRecoveryFileWrapper,
  asBridgeFailure,
  assertNotAlreadyProtected,
  bundleFromStore,
  clearPendingMerge,
  cloudRecover,
  createRecoverySession,
  effectiveCanonicalBase,
  LocalKeyStoreError,
  fetchRemoteCanonical,
  generateMmk,
  globalManifestDigest,
  hashBytes,
  isProtectInProgress,
  migrateLocalStore,
  PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE,
  protectInProgressMessage,
  replicaOfRetiredGeneration,
  replicasNeedingOriginalKey,
  RemoteMemoryError,
  migrateStandardToProtected,
  newKeyring,
  openMmkFromEnvelope,
  parseRecoveryFile,
  protectedCloudBackup,
  pushCanonicalMemory,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRegistry,
  refreshPortableSnapshot,
  composeBundleSnapshot,
  type BundleSnapshotConflict,
  type PortableRegistrySnapshot,
  resolveProjectForIdentity,
  standardCloudBackup,
  unwrapWithRecoveryKey,
  isHistoricalRecovery,
  recordedAsHistorical,
  readLocalRecoveryState,
  readMemoryManifest,
  writeCanonicalBase,
  writeCanonicalMain,
  writeLocalRecoveryState,
  writeMemoryObject,
  writePendingMerge,
  v1ManifestFingerprint,
  type BackupResult,
  type CanonicalMainManifest,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type BridgeEnvelope,
  type BridgeFailureReason,
  type LocalMemoryKeyStore,
  type LocalRecoveryState,
  type MergeConflict,
  type MmkKeyring,
  type MmkWrapper,
  type RecoveryKeyArtifacts,
  type RemoteMemoryBackend,
} from '@stack/memory';

/**
 * How a passkey ceremony can end short of success (Phase R6). `timed-out` and
 * `session-expired` come from the CLI's bounded poll; the others are relayed by the
 * browser through the one-time envelope channel. None ever yields an MMK.
 */
export type PasskeyFailureReason =
  BridgeFailureReason | 'timed-out' | 'session-expired';

export type MemoryCloudDeps = {
  stackHome: string;
  /** Authenticated per-user backend, or null when the user is not signed in. */
  backend: RemoteMemoryBackend | null;
  localKeyStore: LocalMemoryKeyStore;
  runLocalBackup: () => Promise<BackupResult>;
  now?: () => Date;
  /**
   * Read-only, best-effort: this account's Projects (id + safe display name), used
   * ONLY to seed a recovered Project's Cloud-known name locally right after `memory
   * recover` (see `seedRecoveredProjectNames`) — never read from the Memory bundle
   * itself. Optional so existing recover tests that don't need this keep working
   * unchanged; a failure here never fails the recovery it decorates.
   */
  fetchProjectNames?: () => Promise<{ projectId: string; name?: string }[]>;
};

/** Canonical projects not locatable on this machine right now — named (spec
 * §4.5), never a silent gap (Task 13 Important-5). */
export type UnavailableCanonicalProject = { projectId: string; name: string };
/** A native-vs-canonical materialize conflict, or a moved-folder source
 * conflict, surfaced instead of being silently dropped (Task 13 Important-5). */
export type CanonicalMaterializeConflict = { projectId: string; path: string; reason: string };

export type CloudBackupOutcome =
  | { status: 'skipped' }
  /** Nothing has ever been staged on THIS machine (no v1 manifest/`stak add .`
   * ever ran) AND Cloud has no Memory history at all for this account either —
   * a pure Skills-only account. Distinct from `skipped` (that means "not signed
   * in"); this means "nothing to back up yet" (Task 13 Important-7(a)). */
  | { status: 'nothing-staged' }
  | { status: 'protected-locked' }
  | { status: 'failed'; message: string }
  | ({ status: 'standard'; generation: number } & CanonicalMaterializeExtras)
  | ({ status: 'protected'; generation: number } & CanonicalMaterializeExtras)
  /** Cloud already has exactly this machine's canonical Memory — no new
   * generation was created (Task 13 Critical-3: `stak memory backup` merges
   * like `stak push` now, so it can genuinely be a no-op). */
  | ({ status: 'up-to-date'; generation: number } & CanonicalMaterializeExtras)
  /** A real three-way-merge conflict against Cloud stopped the publish — no
   * generation was created. Resolve with `stak memory resolve`, then back up
   * again (same contract as `stak push`). */
  | { status: 'conflict'; conflicts: MergeConflict[] };

/** Never silently dropped (Task 13 Important-5) — a successful/no-op Cloud
 * publish can still have unlocatable projects or native materialize conflicts. */
export type CanonicalMaterializeExtras = {
  unavailable?: UnavailableCanonicalProject[];
  materializeConflicts?: CanonicalMaterializeConflict[];
  /** Files materialized back from STAK because migration found them absent
   * natively (Task 13 fix round 4). */
  restoredFromStak?: number;
  /** Spec §4.2.1: former Project IDs folded into their surviving ones. */
  folded?: ProjectFoldNote[];
};

export type MemoryBackupOutcome = {
  local: BackupResult;
  cloud: CloudBackupOutcome;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error.';

const isInsecureLocalKey = (error: unknown): boolean =>
  error instanceof LocalKeyStoreError && error.code === 'insecure-permissions';

/**
 * Enroll this device with the MMK, tolerating a fail-closed permission error: on
 * insecure local storage nothing is persisted (saveMmk cleaned up) and we report
 * not-enrolled rather than aborting a recovery that already succeeded. Other errors
 * propagate.
 */
const enrollDeviceSafe = async (
  localKeyStore: LocalMemoryKeyStore,
  mmk: Buffer,
): Promise<boolean> => {
  try {
    await localKeyStore.saveMmk(mmk);
    return true;
  } catch (error) {
    if (isInsecureLocalKey(error)) return false;
    throw error;
  }
};

/** How the MMK wrapper is stored inside a cloud recovery method (opaque to server). */
type StoredWrapper = { mmkId: string; wrapper: MmkWrapper };

const isStoredWrapper = (value: unknown): value is StoredWrapper =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { mmkId?: unknown }).mmkId === 'string' &&
  typeof (value as { wrapper?: unknown }).wrapper === 'object';

const isOlderThanLatest = (generation: number, cloudLatest: number | null): boolean =>
  cloudLatest !== null && generation < cloudLatest;

/**
 * Record which Cloud generation the local private store now reflects (Phase 15B.6).
 * Machine-local, non-secret provenance so `status` can flag a historical recovery and
 * a later backup can warn before superseding a newer Cloud generation.
 */
const recordRecoveryProvenance = async (
  deps: MemoryCloudDeps,
  recovered: {
    generation: number;
    privacyMode: 'standard' | 'protected';
    cloudLatest: number | null;
    /** The staged state's semantic digest at the moment it reached this generation —
     * lets a later push detect "nothing changed" (see `resolveMemoryPushState`). */
    semanticDigest?: string;
    /** Recover only (Task 13 fix round 3): fingerprint of the v1 manifest the
     * recover just restored — see `LocalRecoveryState.recoveredManifestFingerprint`.
     * Every push omits it, which is what clears the "came from Cloud" signal. */
    recoveredManifestFingerprint?: string;
  },
): Promise<void> => {
  await writeLocalRecoveryState(deps.stackHome, {
    schemaVersion: 1,
    recoveredGeneration: recovered.generation,
    cloudLatestAtRecovery: recovered.cloudLatest,
    recoveredAt: (deps.now ?? (() => new Date()))().toISOString(),
    privacyMode: recovered.privacyMode,
    // Spec §8.5: historical only for a recover of an OLDER generation than the
    // latest at that moment. Every publish/sync records `cloudLatest ===
    // generation`, which is what clears it.
    historical: isOlderThanLatest(recovered.generation, recovered.cloudLatest),
    ...(recovered.semanticDigest
      ? { semanticDigest: recovered.semanticDigest }
      : {}),
    ...(recovered.recoveredManifestFingerprint
      ? { recoveredManifestFingerprint: recovered.recoveredManifestFingerprint }
      : {}),
  });
};

/**
 * Final review T15-2: a push or backup that ends `up-to-date` proves local
 * Memory equals Cloud's `generation`, so record that as this machine's
 * provenance, exactly as a publish does. Otherwise a rollback whose content
 * already matched Cloud kept the historical-recovery flag forever (every push
 * announcing a rollback it never publishes). Advances only, never backwards.
 */
export const recordInSyncWithCloud = async (deps: MemoryCloudDeps, generation: number): Promise<void> => {
  if (!deps.backend) return;
  const provenance = await readLocalRecoveryState(deps.stackHome);
  if (provenance && !recordedAsHistorical(provenance) && provenance.recoveredGeneration >= generation) return;
  await recordRecoveryProvenance(deps, {
    generation,
    privacyMode: (await deps.backend.getProfile())?.privacyMode ?? 'standard',
    cloudLatest: generation,
  });
};

/**
 * Called once `stak memory protect` has finalized (recovery-file or passkey,
 * fresh or resumed). Protect re-encrypts each Standard generation as a
 * Protected replica under a NEW, higher generation number and retires the
 * original, but this machine's provenance still names the original. Status
 * would then compare it with the replica that is now latest and report a
 * "historical recovery" (and `stak push` a rollback) for identical content.
 *
 * Moves each recorded generation (`recoveredGeneration`, `cloudLatestAtRecovery`)
 * that is no longer committed onto its committed Protected replica, using the
 * same `replicaOf` lookup as `effectiveCanonicalBase`. A genuine historical
 * recover moves to the OLDER generation's replica, so it stays historical. The
 * semantic digest is kept (the replica's plaintext is byte-identical), as are
 * the recover fingerprint and timestamp.
 *
 * Best-effort: Cloud is already Protected, and protect can't be re-run to
 * retry this, so a local failure here must not fail protect. The next push
 * or backup that ends up to date records fresh provenance anyway.
 */
const moveProvenanceToProtectReplicas = async (
  stackHome: string,
  backend: RemoteMemoryBackend,
): Promise<void> => {
  try {
    const provenance = await readLocalRecoveryState(stackHome);
    if (!provenance) return;
    const replicaGenerationOf = async (generation: number): Promise<number> => {
      if ((await backend.getGeneration(generation)) !== null) return generation;
      return (await replicaOfRetiredGeneration(backend, generation))?.generation ?? generation;
    };
    const recoveredGeneration = await replicaGenerationOf(provenance.recoveredGeneration);
    const cloudLatestAtRecovery =
      provenance.cloudLatestAtRecovery === null ? null : await replicaGenerationOf(provenance.cloudLatestAtRecovery);
    if (
      recoveredGeneration === provenance.recoveredGeneration &&
      cloudLatestAtRecovery === provenance.cloudLatestAtRecovery
    )
      return;
    await writeLocalRecoveryState(stackHome, {
      ...provenance,
      // Decided from the generations as recorded, before any is moved: a
      // replica numbering can't turn a sync into a rollback or back.
      historical: recordedAsHistorical(provenance),
      recoveredGeneration,
      cloudLatestAtRecovery,
      ...(recoveredGeneration !== provenance.recoveredGeneration ? { privacyMode: 'protected' as const } : {}),
    });
  } catch {
    // See above: never fail a finished protect over local provenance.
  }
};

/**
 * Read-time counterpart of `moveProvenanceToProtectReplicas`, for every
 * machine that did NOT run protect (and for homes protected before that fix):
 * when the recorded generation is older than `latest`, and protect retired it
 * in favour of a committed Protected replica (same plaintext), treat the
 * replica's generation as the recorded one. Same `replicaOf` lookup as
 * `effectiveCanonicalBase`. A genuine older recover maps to the older
 * generation's replica and stays historical.
 *
 * Read-only (never writes provenance). Only when the recorded generation is
 * behind `latest`: one `getGeneration` (a still-committed generation is
 * returned unchanged), then the replica lookup only if it was retired. Fails safe: on any lookup error the
 * recorded provenance is returned unchanged (today's behaviour).
 *
 * Whether the state is historical never depends on this mapping: it is
 * decided from the state as recorded (`recordedAsHistorical`) and carried
 * explicitly onto the mapped state. Being behind is not historical; the mapping
 * only keeps the displayed "Backup #N" a generation Cloud still holds.
 */
const effectiveRecoveryProvenance = async (
  backend: RemoteMemoryBackend,
  provenance: LocalRecoveryState | null,
  latest: number | null,
): Promise<LocalRecoveryState | null> => {
  if (!provenance || latest === null || provenance.recoveredGeneration >= latest) return provenance;
  try {
    // Still committed: not retired by protect (as in `effectiveCanonicalBase`).
    if ((await backend.getGeneration(provenance.recoveredGeneration)) !== null) return provenance;
    const replica = await replicaOfRetiredGeneration(backend, provenance.recoveredGeneration);
    return replica
      ? { ...provenance, historical: recordedAsHistorical(provenance), recoveredGeneration: replica.generation }
      : provenance;
  } catch {
    return provenance;
  }
};

/** Fingerprint of the v1 manifest currently on disk (right after a recover). */
const restoredManifestFingerprint = async (
  stackHome: string,
): Promise<{ recoveredManifestFingerprint?: string }> => {
  const manifest = await readMemoryManifest(stackHome).catch(() => null);
  return manifest ? { recoveredManifestFingerprint: v1ManifestFingerprint(manifest) } : {};
};

/**
 * Task 13 fix round 3 (finding B): a STATELESS "is there anything to push at
 * all?" check, replacing the old "did a manifest exist before migration"
 * guard (which migration's own empty `manifests/current.json` defeated on
 * every second push or pull). Nothing to push exactly when Cloud has no Memory
 * generation, local canonical main has no documents, and the global v1
 * manifest has no items — then no generation is published. Run AFTER
 * migration (so any v1 project content has already moved into canonical main).
 */
export const hasNothingToPush = async (deps: MemoryCloudDeps): Promise<boolean> => {
  if (!deps.backend) return false;
  if ((await deps.backend.getLatest()) !== null) return false;
  const main = await readCanonicalMain(deps.stackHome);
  if (main.projects.some((project) => project.documents.length > 0)) return false;
  const manifest = await readMemoryManifest(deps.stackHome);
  return (manifest?.items.length ?? 0) === 0;
};

/**
 * Hash of the canonical, PRE-ENCRYPTION bundle `bundleFromStore` would produce right
 * now from the staged local manifest/content store/portable registry snapshot —
 * identical staged state always hashes identically, regardless of Protected mode's
 * per-upload randomized ciphertext. Null when nothing is staged yet (no local
 * manifest). Read-only: never mutates the store.
 *
 * `canonicalMainOverride` bundles THAT canonical Memory instead of whatever's on
 * disk (see `bundleFromStore`'s identical option) — so this digest reflects
 * exactly what a publish is about to upload, never a stale on-disk value.
 * `registrySnapshotOverride` does the same for the bundled registry snapshot.
 */
const computeSemanticDigest = async (
  stackHome: string,
  canonicalMainOverride?: CanonicalMainManifest,
  registrySnapshotOverride?: PortableRegistrySnapshot,
): Promise<string | null> => {
  try {
    const { bytes } = await bundleFromStore(stackHome, {
      ...(canonicalMainOverride ? { canonicalMainOverride } : {}),
      ...(registrySnapshotOverride ? { registrySnapshotOverride } : {}),
    });
    return hashBytes(bytes);
  } catch (error) {
    if (error instanceof BundleError && error.code === 'no-backup') return null;
    throw error;
  }
};

/**
 * After a successful `cloudRecover`, seed each recovered Project's Cloud-known display
 * name locally (so it is visible BEFORE any mapping — see `applyRecoveredProjectNames`).
 * Read from Cloud's project list, never from the Memory bundle. Best-effort: recovery
 * has already succeeded by the time this runs, and a failure here (offline, no
 * `fetchProjectNames` deps, etc.) must never surface as a recovery failure.
 */
const seedRecoveredProjectNames = async (deps: {
  stackHome: string;
  fetchProjectNames?: () => Promise<{ projectId: string; name?: string }[]>;
}): Promise<void> => {
  if (!deps.fetchProjectNames) return;
  try {
    const names = await deps.fetchProjectNames();
    await applyRecoveredProjectNames({ stackHome: deps.stackHome, names });
  } catch {
    // Best-effort only — the name re-appears on the next successful recover/backup.
  }
};

/**
 * Upload whatever Memory is ALREADY staged in the local manifest (`memory/manifests/
 * current.json`) to Cloud. Never calls `deps.runLocalBackup()` and never rescans native
 * Memory or rewrites the local manifest — that is `stak add .`'s job, not push's. Shares
 * every byte of logic with `runMemoryCloudBackup`'s Cloud branch below on purpose: the
 * only difference from that function is skipping its forced local-rescan step.
 */
export const pushStagedMemory = async (
  deps: MemoryCloudDeps,
): Promise<CloudBackupOutcome> => {
  if (!deps.backend) return { status: 'skipped' };
  try {
    // Same as `publishCanonicalGeneration`: bundle a current registry snapshot.
    await refreshPortableSnapshot(deps.stackHome);
    const semanticDigest = await computeSemanticDigest(deps.stackHome);
    const profile = await deps.backend.getProfile();
    const mode = profile?.privacyMode ?? 'standard';
    if (mode === 'protected') {
      const mmk = await deps.localKeyStore.loadMmk();
      if (!mmk) return { status: 'protected-locked' };
      const result = await protectedCloudBackup({
        stackHome: deps.stackHome,
        backend: deps.backend,
        mmk,
        ...(deps.now ? { now: deps.now } : {}),
      });
      // Local state now equals the new latest generation — clear any historical
      // provenance so status returns to normal.
      await recordRecoveryProvenance(deps, {
        generation: result.generation,
        privacyMode: 'protected',
        cloudLatest: result.generation,
        ...(semanticDigest ? { semanticDigest } : {}),
      });
      return { status: 'protected', generation: result.generation };
    }
    const result = await standardCloudBackup({
      stackHome: deps.stackHome,
      backend: deps.backend,
      ...(deps.now ? { now: deps.now } : {}),
    });
    await recordRecoveryProvenance(deps, {
      generation: result.generation,
      privacyMode: 'standard',
      cloudLatest: result.generation,
      ...(semanticDigest ? { semanticDigest } : {}),
    });
    return { status: 'standard', generation: result.generation };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
};

/**
 * Upload exactly one new Cloud generation built from `main` — bundled directly
 * from this IN-MEMORY value (`standardCloudBackup`/`protectedCloudBackup`'s
 * `canonicalMainOverride`), never by writing `main` to `canonical/main.json`
 * first. Task 13 Important-4 review finding: writing to disk before the upload
 * even attempts broke "local main and base move together, only after a
 * successful publish" — a failed or conflicting publish would otherwise leave
 * disk holding content no generation ever actually committed, visible to every
 * other command in between. This function writes NOTHING to local canonical
 * storage, on success or failure; `pushCanonicalMemory`/`pullCanonicalMemory`'s
 * own `setLocalMain`/`setBase` callbacks (wired by callers) persist `main` to
 * disk — and ONLY after a publish they orchestrated actually succeeds.
 *
 * Unlike `pushStagedMemory`, this lets any thrown error (including
 * `RemoteMemoryError('conflict', ...)`) propagate — `pushCanonicalMemory`'s
 * retry loop (`@stack/memory`'s `canonical/push.ts`) depends on seeing that
 * error, not a swallowed `{status:'failed'}` result.
 *
 * Deviates from the Task 13 brief's literal `Promise<{ generation: number }>`
 * return type by also returning `privacyMode`: `runMemoryCloudBackup`'s Cloud
 * branch (below) needs it to populate `CloudBackupOutcome`'s existing
 * `'standard' | 'protected'` status discriminant, and nothing else in this file
 * computes that independently of the backup call actually made.
 */
export const publishCanonicalGeneration = async (
  deps: MemoryCloudDeps,
  main: CanonicalMainManifest,
  /**
   * The EXACT `expectedParent` `pushCanonicalMemory`/`pullCanonicalMemory`
   * decided to publish against (Task 13 fix round 2, Critical-1: lost update).
   * Threaded straight through to `standardCloudBackup`/`protectedCloudBackup`,
   * which must NEVER re-read `getLatest()` for this path — doing so could
   * silently adopt a DIFFERENT, newer generation that another machine pushed
   * in between the canonical engine's own fetch and this publish call, letting
   * `createGeneration`'s optimistic-concurrency check compare against the
   * wrong parent and overwrite that machine's change instead of conflicting.
   */
  expectedParent: number | null,
  /**
   * The portable registry snapshot of the Cloud generation the canonical engine
   * fetched (and is publishing on top of). Records for projects in `main` that
   * this machine has no record of are carried into the bundle, read-only — see
   * `composeBundleSnapshot`. Omitted when nothing was fetched.
   */
  remoteSnapshot?: PortableRegistrySnapshot,
): Promise<{
  generation: number;
  privacyMode: 'standard' | 'protected';
  /** Local/remote snapshot disagreements resolved in favor of the local record. */
  snapshotConflicts: BundleSnapshotConflict[];
}> => {
  if (!deps.backend) throw new Error('No Cloud backend configured.');
  // Task 13 fix round 6: the canonical engine publishes with `expectedParent:
  // null` whenever Cloud has NO committed generation. On an account that has
  // had generations (all since retired, e.g. Delete Cloud Memory) the commit
  // checks against the never-reset counter, so use it — but only while there
  // is still no committed generation; if one appeared, keep null and let the
  // commit conflict and the engine re-fetch.
  if (expectedParent === null && (await deps.backend.getLatest()) === null)
    expectedParent = (await deps.backend.getProfile())?.latestGeneration ?? null;
  // Two-machine fix: the bundle must carry a portable registry snapshot derived
  // from the registry AS IT IS NOW. Canonical staging mints Project IDs after the
  // legacy staging step last wrote the snapshot, so without this a fresh machine
  // receives an empty snapshot and cannot locate the project by its Git claim.
  // The local snapshot FILE stays this machine's own (local registry only).
  await refreshPortableSnapshot(deps.stackHome);
  // The BUNDLED snapshot additionally carries, read-only and in memory only, the
  // remote generation's records for projects in `main` this machine has no
  // record of. Otherwise a machine that never located a project would strip
  // that project's identity from Cloud on every push.
  const { snapshot, conflicts: snapshotConflicts } = composeBundleSnapshot(
    await readLocalRegistry(deps.stackHome),
    remoteSnapshot,
    main.projects.map((p) => p.projectId),
  );
  const semanticDigest = await computeSemanticDigest(deps.stackHome, main, snapshot);
  const profile = await deps.backend.getProfile();
  const mode = profile?.privacyMode ?? 'standard';
  if (mode === 'protected') {
    const mmk = await deps.localKeyStore.loadMmk();
    if (!mmk) throw new Error('Protected Memory is locked on this machine.');
    const result = await protectedCloudBackup({
      stackHome: deps.stackHome,
      backend: deps.backend,
      mmk,
      canonicalMainOverride: main,
      registrySnapshotOverride: snapshot,
      expectedParent,
      ...(deps.now ? { now: deps.now } : {}),
    });
    await recordRecoveryProvenance(deps, {
      generation: result.generation,
      privacyMode: 'protected',
      cloudLatest: result.generation,
      ...(semanticDigest ? { semanticDigest } : {}),
    });
    return { generation: result.generation, privacyMode: 'protected', snapshotConflicts };
  }
  const result = await standardCloudBackup({
    stackHome: deps.stackHome,
    backend: deps.backend,
    canonicalMainOverride: main,
    registrySnapshotOverride: snapshot,
    expectedParent,
    ...(deps.now ? { now: deps.now } : {}),
  });
  await recordRecoveryProvenance(deps, {
    generation: result.generation,
    privacyMode: 'standard',
    cloudLatest: result.generation,
    ...(semanticDigest ? { semanticDigest } : {}),
  });
  return { generation: result.generation, privacyMode: 'standard', snapshotConflicts };
};

export type MemoryPushState =
  | { status: 'nothing-staged' }
  | { status: 'no-remote-backup' }
  | { status: 'already-up-to-date'; generation: number }
  | { status: 'needs-push' };

/**
 * Whether the top-level `stak push` actually needs to create a new Memory generation.
 * `stak push` means "synchronize MAIN to Cloud" — if staged MAIN already equals the
 * latest Cloud generation, pushing again must be a no-op, never another immutable
 * generation containing identical state. (`stak memory backup` is a different,
 * explicit command and keeps its own "always create a generation" behavior — this
 * function is not used there.)
 *
 * Equality is decided from STAGED state only (the local manifest + content store +
 * portable Project registry snapshot `bundleFromStore` bundles) — native/machine
 * state the user hasn't `stak add .`-ed is irrelevant, by design.
 *
 * - Standard mode: compares the local semantic digest directly against the latest
 *   generation's own `payloadSha256` (Standard's uploaded payload IS the plaintext
 *   bundle) — correct even across machines, no local cache needed.
 * - Protected mode: the uploaded payload is randomized ciphertext, so the ONLY stable
 *   comparison is against the semantic digest this same machine recorded the last
 *   time IT pushed (`local-recovery-state.ts`) — valid only when that local record's
 *   generation still matches Cloud's actual latest (nothing moved underneath it).
 */
export const resolveMemoryPushState = async (
  deps: MemoryCloudDeps,
): Promise<MemoryPushState> => {
  const semanticDigest = await computeSemanticDigest(deps.stackHome);
  if (semanticDigest === null) return { status: 'nothing-staged' };
  if (!deps.backend) return { status: 'no-remote-backup' };
  const latest = await deps.backend.getLatest();
  if (!latest) return { status: 'no-remote-backup' };
  if (latest.privacyMode === 'standard')
    return semanticDigest === latest.payloadSha256
      ? { status: 'already-up-to-date', generation: latest.generation }
      : { status: 'needs-push' };
  const local = await readLocalRecoveryState(deps.stackHome);
  return local?.recoveredGeneration === latest.generation &&
    local.semanticDigest === semanticDigest
    ? { status: 'already-up-to-date', generation: latest.generation }
    : { status: 'needs-push' };
};

/**
 * backup: local first, then Cloud (never fails the local commit). Migrates the
 * local store to canonical Memory first (idempotent, short-circuits after its
 * first run — see `migrateLocalStore`), then ALWAYS publishes a new generation
 * built from canonical Memory (unlike `stak push`'s `pushMemoryViaCanonical`,
 * which is a no-op when nothing changed) — this is `stak memory backup`'s own,
 * intentionally unchanged "always create a generation" behavior (spec §9.3:
 * `memory backup` stays as a deprecated alias for the Memory part of `stak
 * push`, with that one behavioral difference preserved).
 *
 * NOTE: concurrent STAK commands against the same `stackHome` are not
 * serialized across processes (see `canonical-ops.ts`'s `pushMemoryViaCanonical`/
 * `pullMemoryViaCanonical` for the same caveat) — a cross-process lock is a
 * known, deferred design gap.
 */
/**
 * Spec Appendix A.4 / Task 13 fix round 2, finding 7 — same fix as
 * `canonical-ops.ts`'s identically-named helper (duplicated rather than
 * imported, for the same circular-module reason as this file's own
 * `fetchRemote` closure in `runMemoryCloudBackup` below): seed
 * `canonical/base.json` from the Cloud generation THIS MACHINE last pushed or
 * recovered in v1, when known — never Cloud's current latest. Lazy,
 * idempotent (never overwrites an existing base), safe no-op when the
 * generation isn't known or can't be fetched.
 */
const seedBaseFromLastKnownV1Generation = async (
  deps: MemoryCloudDeps,
  mmk: Buffer | undefined,
): Promise<void> => {
  if (!deps.backend) return;
  if ((await readCanonicalBase(deps.stackHome)) !== null) return;
  const localMain = await readCanonicalMain(deps.stackHome);
  if (localMain.projects.length === 0) return;
  const provenance = await readLocalRecoveryState(deps.stackHome);
  const knownGeneration = provenance?.recoveredGeneration;
  if (knownGeneration === null || knownGeneration === undefined) return;
  try {
    const result = await fetchRemoteCanonical({
      backend: deps.backend,
      ...(mmk ? { mmk } : {}),
      localRegistry: await readLocalRegistry(deps.stackHome),
      generation: knownGeneration,
    });
    if (!result) return;
    await writeCanonicalBase(deps.stackHome, { generation: result.generation, main: result.main });
  } catch {
    // Leave base empty — the documented safe fallback.
  }
};

/** Final review T15-4: shared by `stak push`'s preflight and `stak memory
 * backup` — after recovering an OLDER backup, a machine with no canonical sync
 * base can't tell its rollback apart from Cloud (seeding the base from the
 * recovered generation would silently discard the rollback). */
export const HISTORICAL_NO_SYNC_HISTORY_MESSAGE =
  'Local Memory was recovered from an older STAK Cloud backup, and this machine has no Memory sync history yet, so STAK could not tell the rollback apart from Cloud. Run `stak memory recover` to catch up to the latest backup first. Nothing was changed in Cloud.';

/** True in exactly the T15-4 case: a historical recover and no sync base. */
export const isHistoricalWithoutSyncHistory = async (deps: MemoryCloudDeps): Promise<boolean> => {
  if (!deps.backend) return false;
  const latest = (await deps.backend.getProfile())?.latestGeneration ?? null;
  const provenance = await effectiveRecoveryProvenance(
    deps.backend,
    await readLocalRecoveryState(deps.stackHome),
    latest,
  );
  if (!isHistoricalRecovery(provenance, latest)) return false;
  return (await readCanonicalBase(deps.stackHome)) === null;
};

/**
 * `stak push`'s Memory preflight (spec §8.5), wired by `program.ts`'s
 * `memoryPushPreflight`. After `stak memory recover --backup N` the rollback is
 * ordinary local changes against this machine's sync base, so push publishes it
 * through the canonical merge like any other push, announced by `note`. The one
 * case the merge does NOT cover is a historical recover with no canonical base
 * yet: push would seed the base from the recovered generation itself and
 * silently discard the rollback, so that case stays blocked (T15-4).
 */
export const resolveMemoryPushPreflight = async (
  deps: MemoryCloudDeps,
): Promise<{ blocked: boolean; reason?: string; note?: string }> => {
  const status = await readMemoryCloudStatus(deps);
  if (!status.historicalRecovery) return { blocked: false };
  if ((await readCanonicalBase(deps.stackHome)) === null)
    return { blocked: true, reason: HISTORICAL_NO_SYNC_HISTORY_MESSAGE };
  return {
    blocked: false,
    note: `Memory: publishing a rollback to Backup #${status.localRecoveredGeneration ?? '?'}.`,
  };
};

export const runMemoryCloudBackup = async (
  deps: MemoryCloudDeps,
  options: {
    /** Runs the local v1 -> canonical migration. `program.ts` passes
     * `canonical-ops.ts`'s `migrateWithProjectionSeed` (with this machine's
     * discovery), so a migration triggered by `stak memory backup` seeds the
     * projection exactly like one triggered by push/pull (Task 13 fix round 3,
     * finding C) — injected rather than imported to avoid a circular import
     * between this module and `canonical-ops.ts`. Defaults to a plain
     * `migrateLocalStore` with no directory locator. */
    migrate?: (stackHome: string) => Promise<unknown>;
  } = {},
): Promise<MemoryBackupOutcome> => {
  const local = await deps.runLocalBackup();
  // NOTE: concurrent STAK commands against the same stackHome are not
  // serialized across processes (see `canonical-ops.ts`'s `pushMemoryViaCanonical`/
  // `pullMemoryViaCanonical` for the same caveat) — a cross-process lock is a
  // known, deferred design gap.
  if (options.migrate) await options.migrate(deps.stackHome);
  else await migrateLocalStore(deps.stackHome);
  if (!deps.backend) return { local, cloud: { status: 'skipped' } };
  // Task 13 fix round 2 (Minor): `getProfile`/`loadMmk` moved INSIDE the try —
  // a network error reading the profile (or anything else below) now returns
  // `{status:'failed'}` alongside the already-safe local backup, instead of
  // propagating past this function entirely.
  try {
    const profile = await deps.backend.getProfile();
    if (
      (profile?.privacyMode ?? 'standard') === 'protected' &&
      !(await deps.localKeyStore.loadMmk().catch(() => null))
    )
      return { local, cloud: { status: 'protected-locked' } };
    const mmk = (await deps.localKeyStore.loadMmk().catch(() => undefined)) ?? undefined;
    // Also persists every object the fetched generation carries into this
    // machine's local content store (same fix as `canonical-ops.ts`'s
    // `remoteOf` — a materialize/merge elsewhere needs the actual bytes, not
    // just the manifest metadata).
    // The fetched generation's registry snapshot, carried into the publish
    // (see `publishCanonicalGeneration`'s `remoteSnapshot`).
    let remoteSnapshot: PortableRegistrySnapshot | undefined;
    // Spec §4.2.1: Cloud's latest is fetched once up front for the project
    // fold below; the merge engine's first fetch reuses it.
    let prefetched: Awaited<ReturnType<typeof fetchNow>> | undefined;
    const fetchRemote = async () => {
      if (prefetched !== undefined) {
        const result = prefetched;
        prefetched = undefined;
        return result;
      }
      return fetchNow();
    };
    const fetchNow = async () => {
      remoteSnapshot = undefined;
      if (!deps.backend) return null;
      const result = await fetchRemoteCanonical({
        backend: deps.backend,
        ...(mmk ? { mmk } : {}),
        localRegistry: await readLocalRegistry(deps.stackHome),
      });
      if (!result) return null;
      remoteSnapshot = result.registrySnapshot;
      for (const object of result.objects)
        await writeMemoryObject({ stackHome: deps.stackHome, contentHash: object.contentHash, bytes: object.bytes });
      return {
        generation: result.generation,
        contentGeneration: result.contentGeneration,
        main: result.main,
        globalDigest: result.globalDigest,
      };
    };
    // Spec §4.2.1: fold before any sync decision, exactly as `stak push` does.
    prefetched = await fetchNow();
    const { notes: folded } = await foldProjectMemory(deps.stackHome, { remoteSnapshot });
    const foldedExtra = folded.length > 0 ? { folded } : {};

    // Task 14 fix round 1 — spec A.6 `merge-pending`, the same gate as `stak
    // push`: a still-current pending merge against an unmoved Cloud stops here
    // before anything changes (its partial resolutions are kept).
    try {
      await assertNoCurrentPendingMerge(deps);
    } catch (error) {
      if (error instanceof MemorySyncError)
        return { local, cloud: { status: 'conflict', conflicts: error.conflicts } };
      throw error;
    }

    // Final review T15-4: the same block as `stak push` — checked BEFORE the
    // base is seeded from the recovered generation, which would discard the
    // rollback the user just confirmed.
    if (await isHistoricalWithoutSyncHistory(deps))
      return { local, cloud: { status: 'failed', message: HISTORICAL_NO_SYNC_HISTORY_MESSAGE } };

    // Spec Appendix A.4 / Task 13 finding 7: lazily seed base from this
    // machine's own last-known v1 generation, before the first canonical merge.
    await seedBaseFromLastKnownV1Generation(deps, mmk);

    // Task 13 Important-7(a) / fix round 3 (finding B): a Skills-only account
    // with no Memory anywhere must not publish an empty Memory generation —
    // decided statelessly from content, never from file existence.
    if (await hasNothingToPush(deps)) return { local, cloud: { status: 'nothing-staged' } };

    // Spec §9.3: `stak memory backup` is a deprecated alias for the Memory HALF
    // of `stak push` — it must merge against Cloud exactly like push does
    // (fetch, three-way merge, at most one generation, conflict stops the
    // publish entirely), never blindly overwrite it (Task 13 Critical-3).
    const outcome = await pushCanonicalMemory({
      getLocalMain: () => readCanonicalMain(deps.stackHome),
      // Final review I1: a global-only Memory change is published too.
      getLocalGlobalDigest: async () => globalManifestDigest(await readMemoryManifest(deps.stackHome)),
      // Task 13 fix round 7: a base Cloud no longer holds merges as empty.
      getBase: async () => effectiveCanonicalBase(deps.backend, await readCanonicalBase(deps.stackHome)),
      setLocalMain: (nextMain) => writeCanonicalMain(deps.stackHome, nextMain),
      setBase: (base) => writeCanonicalBase(deps.stackHome, base),
      fetchRemote,
      publish: async (nextMain, expectedParent) => {
        const result = await publishCanonicalGeneration(deps, nextMain, expectedParent, remoteSnapshot);
        return { generation: result.generation };
      },
      savePendingMerge: (pending) => writePendingMerge(deps.stackHome, pending),
      clearPendingMerge: () => clearPendingMerge(deps.stackHome),
    });

    if (outcome.status === 'conflict')
      return { local, cloud: { status: 'conflict', conflicts: outcome.conflicts } };
    if (outcome.status === 'retry-exhausted')
      return {
        local,
        cloud: {
          status: 'failed',
          message: 'STAK Cloud kept moving while backing up Memory. Try again.',
        },
      };
    if (outcome.status === 'up-to-date') {
      await recordInSyncWithCloud(deps, outcome.generation);
      return { local, cloud: { status: 'up-to-date', generation: outcome.generation, ...foldedExtra } };
    }
    // 'pushed': a generation was actually created, in whichever privacy mode
    // this account is currently in (read once, above, before publishing).
    const mode: 'standard' | 'protected' = profile?.privacyMode ?? 'standard';
    return { local, cloud: { status: mode, generation: outcome.generation, ...foldedExtra } };
  } catch (error) {
    return { local, cloud: { status: 'failed', message: errorMessage(error) } };
  }
};

export type CloudRecoverOutcome =
  | {
      status: 'recovered';
      privacyMode: 'standard' | 'protected';
      /**
       * Unique content-addressed BLOBS written by this recovery (after dedup — two
       * logical Memory files with byte-identical content share one object). This is
       * a storage-layer metric, not a user-facing file count; see `files`.
       */
      objects: number;
      /**
       * Logical Memory files now present (the restored manifest's item count) — the
       * number a user should read as "how many of my Memory files are here", distinct
       * from `objects` (which can be LOWER when files share identical content; it is
       * never evidence of loss by itself).
       */
      files: number;
      generation: number;
    }
  | { status: 'needs-recovery-method' }
  | { status: 'not-authenticated' }
  | { status: 'no-backup' };

/**
 * The restored store's logical file count: the v1 manifest's own items PLUS
 * every `present` canonical document (Task 13 fix — once a store migrates,
 * project-scope files move OUT of the v1 manifest into canonical Memory
 * (`migrate.ts`'s `slimToGlobal`); counting only `manifest.items.length` after a
 * migrated recovery would silently undercount, reporting 0 recovered files for
 * an account whose Memory is entirely project-scope). Never thrown — `0` for an
 * unreadable/absent manifest.
 */
const recoveredFileCount = async (stackHome: string): Promise<number> => {
  const manifest = await readMemoryManifest(stackHome);
  const main = await readCanonicalMain(stackHome);
  const canonicalCount = main.projects.reduce(
    (n, project) => n + project.documents.filter((doc) => doc.state === 'present').length,
    0,
  );
  return (manifest?.items.length ?? 0) + canonicalCount;
};

/**
 * Spec §4.2.1, recover and historical recover: the restored `main.json` is
 * Cloud's raw content, and the registry now also holds the recovered
 * snapshot's former IDs. Fold the restored state on disk, and fold the
 * pre-recover Memory with the SAME aliases, so the rollback comparison below
 * never mistakes a merged project for deleted documents. Returns the folded
 * pre-recover Memory.
 */
const foldAfterRecover = async (
  stackHome: string,
  before: CanonicalMainManifest,
): Promise<CanonicalMainManifest> => {
  const aliasOf = projectAliasResolver(await readLocalRegistry(stackHome));
  await foldProjectMemory(stackHome);
  return foldProjectAliases(before, aliasOf).main;
};

/**
 * Spec §7 / §8.5: a HISTORICAL recover (an older generation than Cloud's
 * latest) is a rollback, which must show up as ordinary local changes,
 * deletions included. The recovered `main.json` simply lacks documents added
 * since that generation, so record each one that was present locally before
 * the recover as a tombstone carrying its pre-recover content hash. Existing
 * tombstones absent from the recovered generation are kept. Documents in the
 * recovered generation are never touched. A non-historical recover (latest,
 * e.g. a fresh machine) is left exactly as restored.
 */
const recordRollbackTombstones = async (
  deps: { stackHome: string; now?: (() => Date) | undefined },
  before: CanonicalMainManifest,
  recoveredGeneration: number,
  cloudLatest: number | null,
): Promise<void> => {
  if (cloudLatest === null || recoveredGeneration === cloudLatest) return;
  const recovered = await readCanonicalMain(deps.stackHome);
  const deletedAt = (deps.now ?? (() => new Date()))().toISOString();
  let changed = false;
  const projects = recovered.projects.map((p) => ({ ...p, documents: [...p.documents] }));
  for (const prior of before.projects) {
    let project = projects.find((p) => p.projectId === prior.projectId);
    for (const doc of prior.documents) {
      if (project?.documents.some((d) => d.path === doc.path)) continue;
      const tombstone =
        doc.state === 'deleted'
          ? doc
          : { path: doc.path, state: 'deleted' as const, lastContentHash: doc.contentHash, deletedAt };
      if (!project) {
        project = { projectId: prior.projectId, documents: [] };
        projects.push(project);
      }
      project.documents.push(tombstone);
      changed = true;
    }
  }
  if (!changed) return;
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeCanonicalMain(deps.stackHome, {
    ...recovered,
    projects: projects
      .map((p) => ({ ...p, documents: p.documents.sort(byPath) }))
      .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)),
  });
};

/** Recover the private store from Cloud. Does not touch native agent files. */
export const runMemoryCloudRecover = async (
  deps: MemoryCloudDeps,
  options: { generation?: number; recoveryKey?: Buffer } = {},
): Promise<CloudRecoverOutcome> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  // Task 13 fix round 4: never restore from an account whose protect was
  // interrupted (latest may be a replica of an unfinished migration).
  if (await isProtectInProgress(deps.backend))
    throw new RemoteMemoryError('protect-in-progress', await protectInProgressMessage(deps.backend));
  const meta =
    options.generation !== undefined
      ? await deps.backend.getGeneration(options.generation)
      : await deps.backend.getLatest();
  if (!meta) return { status: 'no-backup' };

  const cloudLatest = (await deps.backend.getLatest())?.generation ?? null;

  const before = await readCanonicalMain(deps.stackHome);

  if (meta.privacyMode === 'standard') {
    const result = await cloudRecover({
      stackHome: deps.stackHome,
      backend: deps.backend,
      ...(options.generation !== undefined
        ? { generation: options.generation }
        : {}),
    });
    await recordRollbackTombstones(deps, await foldAfterRecover(deps.stackHome, before), result.generation, cloudLatest);
    await recordRecoveryProvenance(deps, {
      generation: result.generation,
      privacyMode: 'standard',
      cloudLatest,
      ...(await restoredManifestFingerprint(deps.stackHome)),
    });
    await seedRecoveredProjectNames(deps);
    return {
      status: 'recovered',
      privacyMode: 'standard',
      objects: result.objects,
      files: await recoveredFileCount(deps.stackHome),
      generation: result.generation,
    };
  }

  // Protected: obtain the MMK from this device or an offered recovery key.
  let mmk = await deps.localKeyStore.loadMmk();
  let unlockedViaRecoveryKey = false;
  if (!mmk && options.recoveryKey) {
    mmk = await unlockMmkWithRecoveryKey(deps.backend, options.recoveryKey);
    unlockedViaRecoveryKey = mmk !== null;
  }
  if (!mmk) return { status: 'needs-recovery-method' };

  const result = await cloudRecover({
    stackHome: deps.stackHome,
    backend: deps.backend,
    mmk,
    ...(options.generation !== undefined
      ? { generation: options.generation }
      : {}),
  });
  await recordRollbackTombstones(deps, await foldAfterRecover(deps.stackHome, before), result.generation, cloudLatest);
  // Recovery already succeeded; enrolling this device is best-effort and must not
  // persist insecure key material (enrollDeviceSafe fails closed internally).
  if (unlockedViaRecoveryKey) await enrollDeviceSafe(deps.localKeyStore, mmk);
  await recordRecoveryProvenance(deps, {
    generation: result.generation,
    privacyMode: 'protected',
    cloudLatest,
    ...(await restoredManifestFingerprint(deps.stackHome)),
  });
  await seedRecoveredProjectNames(deps);
  return {
    status: 'recovered',
    privacyMode: 'protected',
    objects: result.objects,
    files: await recoveredFileCount(deps.stackHome),
    generation: result.generation,
  };
};

/**
 * Read the recovery key from a `.stackkey` file for `stak memory recover
 * --recovery-file <path>`. (Final review follow-up: the option was accepted but
 * never read, so recovering with a recovery file always reported the device as
 * locked.) Never echoes file content in its errors.
 */
export const readRecoveryKeyFile = async (filePath: string): Promise<Buffer> => {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Couldn't read the recovery file at ${filePath}. Nothing was changed.`);
  }
  try {
    return parseRecoveryFile(text);
  } catch {
    throw new Error(`${filePath} isn't a STAK recovery file. Nothing was changed.`);
  }
};

/** Try each stored recovery-file wrapper until the recovery key unwraps the MMK. */
const unlockMmkWithRecoveryKey = async (
  backend: RemoteMemoryBackend,
  recoveryKey: Buffer,
): Promise<Buffer | null> => {
  const methods = await backend.listRecoveryMethods();
  for (const method of methods) {
    if (method.type !== 'recovery-file') continue;
    if (!isStoredWrapper(method.mmkWrapper)) continue;
    const keyring: MmkKeyring = {
      mmkId: method.mmkWrapper.mmkId,
      wrappers: [method.mmkWrapper.wrapper],
    };
    try {
      return unwrapWithRecoveryKey({
        keyring,
        wrapper: method.mmkWrapper.wrapper,
        recoveryKey,
      });
    } catch {
      // wrong key for this wrapper — try the next
    }
  }
  return null;
};

export type ProtectOutcome =
  | { status: 'protected'; migrated: number; recoveryMethod: 'recovery-file' }
  | { status: 'insecure-local-key' };

/** Enable Protected: new MMK + recovery-file method + device enrollment + migrate. */
export const runMemoryCloudProtect = async (
  deps: MemoryCloudDeps & { backend: RemoteMemoryBackend },
  options: {
    recoveryKey: RecoveryKeyArtifacts;
    /** Final review I8: saves `recoveryKey`'s file to disk. Called after this
     * device's key is enrolled and BEFORE anything changes in Cloud (the
     * recovery wrapper, replicas, the mode), so a crash or failure later can
     * never leave a Protected account whose only key is on this device. A
     * failure here stops protect with nothing changed in Cloud. */
    writeRecoveryFile?: () => Promise<void>;
  },
): Promise<ProtectOutcome> => {
  // Task 13 fix rounds 3-4: RESUME an interrupted protect with the Memory key
  // this device already enrolled for it, so the replicas already in Cloud are
  // reused. A device WITHOUT that key generates a fresh one: the migration
  // then retires the replicas it can't open and re-replicates with the new
  // key (originals intact) — never a lockout. A fresh recovery file is issued
  // either way, because an interrupted run never wrote one.
  // Final review C1: never on an account that is already Protected.
  await assertNotAlreadyProtected(deps.backend);
  const inProgress = await isProtectInProgress(deps.backend);
  const resumeMmk = inProgress ? await deps.localKeyStore.loadMmk().catch(() => null) : null;
  // Fix round 4 (d): if finishing needs the interrupted run's key (originals
  // already retired) and this device doesn't have one, stop BEFORE generating
  // or enrolling a key or adding a recovery wrapper.
  if (inProgress && !resumeMmk && (await replicasNeedingOriginalKey(deps.backend)).length > 0)
    throw new RemoteMemoryError('protect-in-progress', PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE);
  const mmk = resumeMmk ?? generateMmk();
  // Enroll this device FIRST and fail closed: if local key storage can't be
  // secured, persist nothing and finalize nothing in Cloud.
  if (!resumeMmk && !(await enrollDeviceSafe(deps.localKeyStore, mmk)))
    return { status: 'insecure-local-key' };
  if (options.writeRecoveryFile) await options.writeRecoveryFile();
  const keyring = newKeyring();
  const { wrapper } = addRecoveryFileWrapper({
    keyring,
    mmk,
    recoveryKey: options.recoveryKey.keyBytes,
  });
  const stored: StoredWrapper = { mmkId: keyring.mmkId, wrapper };
  await deps.backend.addRecoveryMethod({
    type: 'recovery-file',
    label: 'Recovery file',
    mmkWrapper: stored,
    cryptoVersion: CIPHER_VERSION,
  });
  // Final review I8: the recovery file for this wrapper is already on disk, so
  // the wrapper is NEVER revoked on failure — it may be the only off-device
  // copy of the key any replicas made so far were sealed with. (The device key
  // stays enrolled too: a re-run on this machine resumes with it.)
  const migration = await migrateStandardToProtected({
    backend: deps.backend,
    mmk,
    ...(deps.now ? { now: deps.now } : {}),
  });
  await moveProvenanceToProtectReplicas(deps.stackHome, deps.backend);
  return {
    status: 'protected',
    migrated: migration.migrated,
    recoveryMethod: 'recovery-file',
  };
};

export type MemoryCloudStatus = {
  authenticated: boolean;
  privacyMode: 'standard' | 'protected' | null;
  latestGeneration: number | null;
  lastCloudBackupAt: string | null;
  recoveryMethodTypes: string[];
  deviceEnrolled: boolean;
  /** Machine-local: which generation the local store was recovered from (Phase 15B.6). */
  localRecoveredGeneration: number | null;
  /** True when local state came from an OLDER generation than the Cloud latest. */
  historicalRecovery: boolean;
};

export const readMemoryCloudStatus = async (
  deps: MemoryCloudDeps,
): Promise<MemoryCloudStatus> => {
  const deviceEnrolled = await deps.localKeyStore.hasKey();
  const recorded = await readLocalRecoveryState(deps.stackHome);
  if (!deps.backend)
    return {
      authenticated: false,
      privacyMode: null,
      latestGeneration: null,
      lastCloudBackupAt: null,
      recoveryMethodTypes: [],
      deviceEnrolled,
      localRecoveredGeneration: recorded?.recoveredGeneration ?? null,
      historicalRecovery: false,
    };
  const profile = await deps.backend.getProfile();
  const latest = await deps.backend.getLatest();
  const methods = await deps.backend.listRecoveryMethods();
  const latestGeneration = profile?.latestGeneration ?? null;
  const provenance = await effectiveRecoveryProvenance(deps.backend, recorded, latestGeneration);
  const localRecoveredGeneration = provenance?.recoveredGeneration ?? null;
  return {
    authenticated: true,
    privacyMode: profile?.privacyMode ?? null,
    latestGeneration,
    lastCloudBackupAt: latest?.createdAt ?? null,
    recoveryMethodTypes: [...new Set(methods.map((method) => method.type))],
    deviceEnrolled,
    localRecoveredGeneration,
    historicalRecovery: isHistoricalRecovery(provenance, latestGeneration),
  };
};

/* -------------------------------------------------------------------------- */
/* Generation history + historical-base backup context (Phase 15B.6)          */
/* -------------------------------------------------------------------------- */

export type MemoryGenerationSummary = {
  generation: number;
  createdAt: string;
  privacyMode: 'standard' | 'protected';
  state: string;
  payloadBytes: number;
  latest: boolean;
};

export type MemoryGenerationsOutcome =
  | { status: 'not-authenticated' }
  | { status: 'ok'; generations: MemoryGenerationSummary[] };

/**
 * List the user's recoverable (committed) Memory generations, newest first. Exposes
 * only non-secret metadata — never backup UUIDs, payload locators, wrapped DEKs,
 * hashes, or contents.
 */
export const runMemoryGenerations = async (
  deps: MemoryCloudDeps,
): Promise<MemoryGenerationsOutcome> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const generations = await deps.backend.listGenerations();
  const latest = generations.reduce<number | null>(
    (max, g) => (max === null || g.generation > max ? g.generation : max),
    null,
  );
  return {
    status: 'ok',
    generations: generations.map((g) => ({
      generation: g.generation,
      createdAt: g.createdAt,
      privacyMode: g.privacyMode,
      state: g.state,
      payloadBytes: g.payloadBytes,
      latest: g.generation === latest,
    })),
  };
};

export type BackupSupersession = {
  localRecoveredGeneration: number | null;
  cloudLatestGeneration: number | null;
  parentGeneration: number | null;
  nextGeneration: number | null;
  supersedes: boolean;
  /** Final review T15-4: superseding from a machine with no Memory sync
   * history — refused (like `stak push`), never confirmable. */
  noSyncHistory?: boolean;
};

/**
 * Read-only context for a backup: the local store's recovery provenance and the Cloud
 * latest. A new backup always parents from the Cloud latest (linear history); when the
 * local store came from an OLDER generation, the backup would supersede a newer Cloud
 * generation and must be explicitly confirmed.
 */
export const readBackupSupersession = async (
  deps: MemoryCloudDeps,
): Promise<BackupSupersession> => {
  const recorded = await readLocalRecoveryState(deps.stackHome);
  if (!deps.backend)
    return {
      localRecoveredGeneration: recorded?.recoveredGeneration ?? null,
      cloudLatestGeneration: null,
      parentGeneration: null,
      nextGeneration: null,
      supersedes: false,
    };
  const cloudLatestGeneration =
    (await deps.backend.getLatest())?.generation ?? null;
  const provenance = await effectiveRecoveryProvenance(deps.backend, recorded, cloudLatestGeneration);
  const localRecoveredGeneration = provenance?.recoveredGeneration ?? null;
  return {
    localRecoveredGeneration,
    cloudLatestGeneration,
    parentGeneration: cloudLatestGeneration,
    nextGeneration:
      cloudLatestGeneration === null ? 0 : cloudLatestGeneration + 1,
    supersedes: isHistoricalRecovery(provenance, cloudLatestGeneration),
    // Final review T15-4: a supersede that can't be published safely at all.
    noSyncHistory:
      isHistoricalRecovery(provenance, cloudLatestGeneration) &&
      (await readCanonicalBase(deps.stackHome)) === null,
  };
};

/**
 * Fresh/reset-registry safeguard. Detects the dangerous combination: this machine's
 * private Memory store has NEVER been recovered from Cloud (`localRecoveredGeneration
 * === null` — not merely "behind", but truly unseeded), Cloud already has Memory
 * history worth preserving (`cloudLatestGeneration !== null`), AND this backup would
 * mint a brand-new Local-only identity this registry has never seen before. Git-backed
 * identities are excluded — they reconcile safely through Cloud's canonical-identity
 * check (`syncProjects`), never through this guard. An ESTABLISHED machine (one whose
 * registry already has ANY prior knowledge — i.e. this native item's identity already
 * resolves locally) is never blocked merely for discovering one more genuinely new
 * project; only a registry with zero prior knowledge of THIS identity, while Cloud
 * already has history, is risky enough to refuse.
 */
export const freshRegistryRisksDuplication = (deps: {
  localRecoveredGeneration: number | null;
  cloudLatestGeneration: number | null;
  nativeItems: Pick<DiscoveredMemoryItem, 'scope' | 'project'>[];
  registry: LocalRegistry;
}): boolean => {
  if (deps.localRecoveredGeneration !== null) return false;
  if (deps.cloudLatestGeneration === null) return false;
  return deps.nativeItems.some(
    (item) =>
      item.scope === 'project' &&
      item.project?.kind === 'local' &&
      resolveProjectForIdentity(deps.registry, item.project).status ===
        'unknown',
  );
};

/* -------------------------------------------------------------------------- */
/* Passkey flows via the CLI↔browser bridge (server relays opaque only)        */
/* -------------------------------------------------------------------------- */

export type BrowserOpener = (url: string) => Promise<void> | void;

export type PasskeyBridgeDeps = {
  stackHome: string;
  backend: RemoteMemoryBackend | null;
  localKeyStore: LocalMemoryKeyStore;
  webBaseUrl: string;
  openBrowser: BrowserOpener;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  fetchProjectNames?: () => Promise<{ projectId: string; name?: string }[]>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';

/**
 * The bounded result of waiting for the browser (Phase R6): either the relayed opaque
 * envelope (which may be a success envelope OR a browser failure signal), or a terminal
 * reason that ended the wait without any browser response. The wait is ALWAYS bounded —
 * it never loops past the session deadline — so the CLI can never appear to hang.
 */
type PollOutcome =
  | { ok: true; envelope: unknown }
  | { ok: false; reason: 'timed-out' | 'session-expired' };

/**
 * Poll the one-time relay for the browser's opaque envelope. The relay reports
 * `no-envelope` until the browser submits (success envelope or failure signal),
 * `session-expired` once the session's lifetime passes, and marks the session consumed
 * on the first successful read. Bounded by `timeoutMs` (the session lifetime).
 */
const pollForEnvelope = async (
  backend: RemoteMemoryBackend,
  sessionId: string,
  options: {
    sleep: (ms: number) => Promise<void>;
    now: () => Date;
    timeoutMs: number;
    pollMs: number;
  },
): Promise<PollOutcome> => {
  const deadline = options.now().getTime() + options.timeoutMs;
  for (;;) {
    try {
      const { envelope } = await backend.consumeRecoverySession(
        sessionId,
        options.now,
      );
      return { ok: true, envelope };
    } catch (error) {
      const code = errorCode(error);
      if (code.endsWith('no-envelope')) {
        if (options.now().getTime() > deadline)
          return { ok: false, reason: 'timed-out' };
        await options.sleep(options.pollMs);
        continue;
      }
      if (code.endsWith('session-expired'))
        return { ok: false, reason: 'session-expired' };
      throw error;
    }
  }
};

export type PasskeyProtectResult =
  | { status: 'not-authenticated' }
  | { status: 'insecure-local-key' }
  | { status: 'passkey-failed'; reason: PasskeyFailureReason }
  | { status: 'protected'; migrated: number };

/**
 * Enable Protected via a passkey: create a one-time enrollment session, open the
 * browser (which creates the passkey, generates the MMK, stores its passkey wrapper,
 * and seals the MMK back), receive the MMK over the bridge, enroll this device, and
 * migrate existing Standard backups.
 */
export const runPasskeyProtect = async (
  deps: PasskeyBridgeDeps,
): Promise<PasskeyProtectResult> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  // Task 13 fix round 3: resume an interrupted protect with the key this
  // device already enrolled for it (the first run's passkey wrapper already
  // wraps that same key) — never a new key the existing replicas can't use.
  // Final review C1: never on an account that is already Protected.
  await assertNotAlreadyProtected(deps.backend);
  if (await isProtectInProgress(deps.backend)) {
    const resumeMmk = await deps.localKeyStore.loadMmk().catch(() => null);
    if (resumeMmk) {
      const resumed = await migrateStandardToProtected({ backend: deps.backend, mmk: resumeMmk, now });
      await moveProvenanceToProtectReplicas(deps.stackHome, deps.backend);
      return { status: 'protected', migrated: resumed.migrated };
    }
    // Fix round 4 (d): never open a passkey ceremony for a key that can't finish.
    if ((await replicasNeedingOriginalKey(deps.backend)).length > 0)
      throw new RemoteMemoryError('protect-in-progress', PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE);
  }
  const { session, initiatorPrivateKey } = await createRecoverySession({
    userId: 'stack-memory',
    ttlMs: deps.ttlMs ?? 5 * 60_000,
    direction: 'enrollment',
    now,
  });
  await deps.backend.createRecoverySession(
    {
      sessionId: session.sessionId,
      direction: 'enrollment',
      session,
      expiresAt: session.expiresAt,
    },
    now,
  );
  await deps.openBrowser(
    `${deps.webBaseUrl}/memory/protect?session=${encodeURIComponent(session.sessionId)}`,
  );
  const poll = await pollForEnvelope(deps.backend, session.sessionId, {
    sleep,
    now,
    timeoutMs: deps.timeoutMs ?? 5 * 60_000,
    pollMs: deps.pollMs ?? 1500,
  });
  // Terminal, MMK-free failures: a bounded timeout/expiry, or a browser failure signal.
  // Return before any key material is derived — no wrapper, no enrollment, no migration.
  if (!poll.ok) return { status: 'passkey-failed', reason: poll.reason };
  const failure = asBridgeFailure(poll.envelope);
  if (failure) return { status: 'passkey-failed', reason: failure };
  const mmk = await openMmkFromEnvelope({
    session,
    initiatorPrivateKey,
    envelope: poll.envelope as BridgeEnvelope,
    now,
  });
  // Fail closed: do not finalize Protected if this device's key store can't be secured.
  if (!(await enrollDeviceSafe(deps.localKeyStore, mmk)))
    return { status: 'insecure-local-key' };
  const migration = await migrateStandardToProtected({
    backend: deps.backend,
    mmk,
    now,
  });
  await moveProvenanceToProtectReplicas(deps.stackHome, deps.backend);
  return { status: 'protected', migrated: migration.migrated };
};

export type PasskeyRecoverResult =
  | { status: 'not-authenticated' }
  | { status: 'no-backup' }
  | { status: 'passkey-failed'; reason: PasskeyFailureReason }
  | { status: 'recovered'; objects: number; files: number; generation: number };

/**
 * Recover Protected Memory via a passkey: create a one-time recovery session, open
 * the browser (which authenticates the passkey, unwraps the MMK via PRF, and seals
 * it back), receive the MMK, enroll this device, and rebuild the local store.
 */
export const runPasskeyRecover = async (
  deps: PasskeyBridgeDeps,
  options: { generation?: number } = {},
): Promise<PasskeyRecoverResult> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  if (await isProtectInProgress(deps.backend))
    throw new RemoteMemoryError('protect-in-progress', await protectInProgressMessage(deps.backend));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  // The CLI authoritatively selects the generation and fetches/decrypts its payload;
  // the browser only unwraps the (generation-independent) MMK, so there is no
  // browser/server generation TOCTOU. Confirm the requested generation exists first.
  const cloudLatest = (await deps.backend.getLatest())?.generation ?? null;
  const selected =
    options.generation !== undefined
      ? await deps.backend.getGeneration(options.generation)
      : await deps.backend.getLatest();
  if (!selected) return { status: 'no-backup' };
  const { session, initiatorPrivateKey } = await createRecoverySession({
    userId: 'stack-memory',
    ttlMs: deps.ttlMs ?? 5 * 60_000,
    direction: 'recovery',
    now,
  });
  await deps.backend.createRecoverySession(
    {
      sessionId: session.sessionId,
      direction: 'recovery',
      session,
      expiresAt: session.expiresAt,
    },
    now,
  );
  await deps.openBrowser(
    `${deps.webBaseUrl}/memory/recover?session=${encodeURIComponent(session.sessionId)}`,
  );
  const poll = await pollForEnvelope(deps.backend, session.sessionId, {
    sleep,
    now,
    timeoutMs: deps.timeoutMs ?? 5 * 60_000,
    pollMs: deps.pollMs ?? 1500,
  });
  // Terminal, MMK-free failures: a bounded timeout/expiry, or a browser failure signal.
  // Return before any unwrap/recover/enroll so no MMK is produced and nothing is marked
  // recovered. The user can retry the passkey or use their recovery file.
  if (!poll.ok) return { status: 'passkey-failed', reason: poll.reason };
  const failure = asBridgeFailure(poll.envelope);
  if (failure) return { status: 'passkey-failed', reason: failure };
  const mmk = await openMmkFromEnvelope({
    session,
    initiatorPrivateKey,
    envelope: poll.envelope as BridgeEnvelope,
    now,
  });
  const before = await readCanonicalMain(deps.stackHome);
  const result = await cloudRecover({
    stackHome: deps.stackHome,
    backend: deps.backend,
    mmk,
    ...(options.generation !== undefined
      ? { generation: options.generation }
      : {}),
  });
  await recordRollbackTombstones(deps, await foldAfterRecover(deps.stackHome, before), result.generation, cloudLatest);
  // Recovery already succeeded; enroll best-effort (never persists insecure state).
  await enrollDeviceSafe(deps.localKeyStore, mmk);
  await writeLocalRecoveryState(deps.stackHome, {
    schemaVersion: 1,
    recoveredGeneration: result.generation,
    cloudLatestAtRecovery: cloudLatest,
    recoveredAt: now().toISOString(),
    privacyMode: 'protected',
    historical: isOlderThanLatest(result.generation, cloudLatest),
    ...(await restoredManifestFingerprint(deps.stackHome)),
  });
  await seedRecoveredProjectNames(deps);
  return {
    status: 'recovered',
    objects: result.objects,
    files: await recoveredFileCount(deps.stackHome),
    generation: result.generation,
  };
};

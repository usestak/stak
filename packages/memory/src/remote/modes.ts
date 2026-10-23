/**
 * Standard vs Protected remote Memory orchestration (production).
 *
 *  STANDARD  — the canonical bundle is uploaded as the payload; Stack Cloud can
 *    technically read it. Still strictly private (per-user, versioned, integrity-
 *    checked, never public/shared). NOT end-to-end encrypted.
 *  PROTECTED — the bundle is AEAD-encrypted under a fresh per-backup DEK, the DEK
 *    wrapped by the MMK; only ciphertext + wrapped DEK + minimal metadata are
 *    uploaded. Stack Cloud can never read it.
 *
 * Both flows go through the same `RemoteMemoryBackend` and create an immutable,
 * numbered generation with optimistic-concurrency (expected-parent) semantics.
 */
import { randomUUID } from 'node:crypto';

import { hashBytes } from '../store.js';
import type { CanonicalMainManifest } from '../canonical/domain.js';
import {
  bundleFromStore,
  restoreBundleToStore,
} from './bundle-codec.js';
import {
  CIPHER_VERSION,
  open,
  randomKey,
  seal,
  type SealedBytes,
} from './cipher.js';
import { unwrapDekWithMmk, wrapDekWithMmk } from './mmk.js';
import { reconcileRegistryAfterRecover } from '../project/registry-store.js';
import {
  REMOTE_FORMAT_VERSION,
  RemoteMemoryError,
  type MemoryGenerationMeta,
  type RemoteMemoryBackend,
} from './backend.js';

export type CloudBackupResult = {
  generation: number;
  backupId: string;
  privacyMode: 'standard' | 'protected';
  payloadSha256: string;
};

export type CloudRecoverResult = {
  generation: number;
  privacyMode: 'standard' | 'protected';
  objects: number;
};

/** AAD binding the encrypted bundle to its (client-generated) backup id. */
const protectedBundleAad = (backupId: string): Buffer =>
  Buffer.from(
    JSON.stringify({ v: CIPHER_VERSION, mode: 'protected', backupId }),
    'utf8',
  );

const splitPayload = (payload: Uint8Array): SealedBytes => {
  const buf = Buffer.from(payload);
  return {
    nonce: buf.subarray(0, 12),
    ciphertext: buf.subarray(12, buf.length - 16),
    tag: buf.subarray(buf.length - 16),
  };
};

const verifyPayload = (bytes: Uint8Array, expectedSha: string): void => {
  if (hashBytes(bytes) !== expectedSha)
    throw new RemoteMemoryError(
      'integrity',
      'Payload failed its integrity hash.',
    );
};

/** Standard: upload the canonical bundle as a new generation. */
export const standardCloudBackup = async (options: {
  stackHome: string;
  backend: RemoteMemoryBackend;
  now?: () => Date;
  /** Bundle this canonical Memory instead of whatever's on disk (Task 13
   * Important-4 fix) — see `bundleFromStore`'s identical option. */
  canonicalMainOverride?: CanonicalMainManifest;
  /**
   * The EXACT `expectedParent` to publish against (Task 13 fix round 2,
   * Critical-1: lost update). When provided (including explicitly `null`, for
   * a first-ever generation), this is used VERBATIM — `getLatest()` is never
   * re-read here. The canonical push engine (`pushCanonicalMemory`) already
   * fetched remote and decided what it was merging/fast-forwarding against;
   * re-reading `getLatest()` at publish time could silently pick up a DIFFERENT,
   * newer generation that arrived in between, making `createGeneration`'s own
   * optimistic-concurrency check compare against the wrong parent and let a
   * lost update through instead of correctly conflicting. Omitted only by the
   * legacy `pushStagedMemory` path, which has no prior fetch to honor.
   */
  expectedParent?: number | null;
}): Promise<CloudBackupResult> => {
  await options.backend.ensureProfile(REMOTE_FORMAT_VERSION);
  const { bundle, bytes } = await bundleFromStore(
    options.stackHome,
    options.canonicalMainOverride ? { canonicalMainOverride: options.canonicalMainOverride } : {},
  );
  const expectedParent =
    options.expectedParent !== undefined
      ? options.expectedParent
      : ((await options.backend.getLatest())?.generation ?? null);
  const meta = await options.backend.createGeneration({
    backupId: randomUUID(),
    expectedParent,
    privacyMode: 'standard',
    payload: bytes,
    // The bundle's OWN format, never hard-coded — a store with canonical Memory
    // produces a v2 bundle, and the server's v1-after-v2 gate (spec §9.3/A.5)
    // depends on this metadata actually reflecting that (see Task 13 Critical-2
    // review finding: hard-coding v1 here made that gate dead code).
    bundleFormatVersion: bundle.bundleFormat,
    ...(options.now ? { now: options.now } : {}),
  });
  return toResult(meta);
};

/** Protected: encrypt the bundle locally, upload ciphertext + wrapped DEK. */
export const protectedCloudBackup = async (options: {
  stackHome: string;
  backend: RemoteMemoryBackend;
  mmk: Buffer;
  now?: () => Date;
  /** Bundle this canonical Memory instead of whatever's on disk (Task 13
   * Important-4 fix) — see `bundleFromStore`'s identical option. */
  canonicalMainOverride?: CanonicalMainManifest;
  /** The EXACT `expectedParent` to publish against — see
   * `standardCloudBackup`'s identical option for why `getLatest()` must never
   * be re-read here once the canonical push engine already fetched remote. */
  expectedParent?: number | null;
}): Promise<CloudBackupResult> => {
  const { bundle, bytes: bundleBytes } = await bundleFromStore(
    options.stackHome,
    options.canonicalMainOverride ? { canonicalMainOverride: options.canonicalMainOverride } : {},
  );
  const backupId = randomUUID();
  const dek = randomKey();
  const sealed = seal(bundleBytes, dek, protectedBundleAad(backupId));
  const payload = Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]);
  const wrappedDek = wrapDekWithMmk(dek, options.mmk, backupId);
  const expectedParent =
    options.expectedParent !== undefined
      ? options.expectedParent
      : ((await options.backend.getLatest())?.generation ?? null);
  const meta = await options.backend.createGeneration({
    backupId,
    expectedParent,
    privacyMode: 'protected',
    payload,
    // The bundle's OWN format (see `standardCloudBackup`'s identical comment) —
    // encryption never changes what format the PLAINTEXT bundle inside it is.
    bundleFormatVersion: bundle.bundleFormat,
    cryptoVersion: CIPHER_VERSION,
    wrappedDek,
    ...(options.now ? { now: options.now } : {}),
  });
  return toResult(meta);
};

/**
 * Recover a generation (latest by default) into the local Phase 14A store.
 * Protected requires the MMK. Reconstruction is byte-exact and hash-verified.
 */
export const cloudRecover = async (options: {
  stackHome: string;
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  generation?: number;
}): Promise<CloudRecoverResult> => {
  const meta =
    options.generation !== undefined
      ? await options.backend.getGeneration(options.generation)
      : await options.backend.getLatest();
  if (!meta)
    throw new RemoteMemoryError('not-found', 'No backup found to recover.');
  const payload = await options.backend.getPayload(meta.backupId);
  verifyPayload(payload, meta.payloadSha256);

  let bundleBytes: Uint8Array;
  if (meta.privacyMode === 'standard') {
    bundleBytes = payload;
  } else {
    if (!options.mmk)
      throw new RemoteMemoryError(
        'mmk-required',
        'Protected recovery requires the Memory Master Key.',
      );
    if (!meta.wrappedDek)
      throw new RemoteMemoryError(
        'not-protected',
        'Protected generation is missing its wrapped DEK.',
      );
    const dek = unwrapDekWithMmk(meta.wrappedDek, options.mmk, meta.backupId);
    bundleBytes = open(
      splitPayload(payload),
      dek,
      protectedBundleAad(meta.backupId),
    );
  }

  const restored = await restoreBundleToStore({
    bytes: bundleBytes,
    stackHome: options.stackHome,
  });
  // Phase 15B: reconcile the portable project registry the bundle carried (or lazily
  // migrate legacy identities when it carried none). Never creates a path binding.
  await reconcileRegistryAfterRecover({ stackHome: options.stackHome });
  return {
    generation: meta.generation,
    privacyMode: meta.privacyMode,
    objects: restored.objects,
  };
};

export type MigrationResult = {
  migrated: number;
  /** Originals that already had a verified replica from an earlier,
   * interrupted run and were therefore not copied again (resume). */
  resumed: number;
  retiredStandard: number;
  finalized: boolean;
};

/**
 * Is a `stak memory protect` migration in progress (or interrupted) for this
 * account? True exactly when the account is still Standard but already holds
 * at least one committed Protected replica (`replicaOf`) — the window between
 * the first replica create and finalize (Task 13 fix round 3).
 */
export const isProtectInProgress = async (
  backend: RemoteMemoryBackend,
): Promise<boolean> => {
  const profile = await backend.getProfile();
  if ((profile?.privacyMode ?? 'standard') !== 'standard') return false;
  const generations = await backend.listGenerations();
  return generations.some(
    (g) => g.privacyMode === 'protected' && typeof g.replicaOf === 'string',
  );
};

export const PROTECT_IN_PROGRESS_MESSAGE =
  'Protecting your Cloud Memory was interrupted before it finished. Nothing was changed on this machine. Run `stak memory protect` again to complete it.';

/** Decrypt a Protected replica and confirm it holds EXACTLY the original
 * Standard payload's bytes. */
const verifyReplica = (
  replicaPayload: Uint8Array,
  replicaBackupId: string,
  wrappedDek: MemoryGenerationMeta['wrappedDek'],
  mmk: Buffer,
  expectedSha: string,
): void => {
  if (!wrappedDek)
    throw new RemoteMemoryError(
      'integrity',
      'A migrated backup is missing its wrapped key; account remains Standard.',
    );
  let roundTrip: Uint8Array;
  try {
    const dek = unwrapDekWithMmk(wrappedDek, mmk, replicaBackupId);
    roundTrip = open(splitPayload(replicaPayload), dek, protectedBundleAad(replicaBackupId));
  } catch {
    throw new RemoteMemoryError(
      'integrity',
      "A migrated backup can't be opened with this device's Memory key; account remains Standard.",
    );
  }
  if (hashBytes(roundTrip) !== expectedSha)
    throw new RemoteMemoryError(
      'integrity',
      'A migrated backup failed verification; account remains Standard.',
    );
};

/**
 * Migrate all Standard generations to Protected replicas, verify each decrypts
 * back to the original bytes, then retire the Standard payloads and finalize the
 * account as Protected. On any failure the account stays Standard and no Standard
 * payload is retired (no partial/false "Protected" state).
 *
 * Task 13 fix round 3:
 *  - Each replica names its original via `replicaOf`, which the server verifies
 *    (see `assertCreateGenerationAllowed`) — the only way a v1-format replica
 *    passes the sticky v1-after-v2 gate.
 *  - `expectedParent` is CHAINED from this run's own previous create (starting
 *    from the latest seen once, up front), never re-read from `getLatest()`
 *    per copy: a concurrent push landing mid-migration makes the next create
 *    conflict, aborting the migration, instead of being silently stranded as
 *    Standard plaintext behind a later replica.
 *  - Resumable: an original that already has a replica (an earlier interrupted
 *    run) is not copied again; its replica is downloaded and verified against
 *    the original with THIS MMK before anything is retired.
 *  - Oldest-first, so the newest original's replica is created last and is the
 *    account's latest after finalize.
 */
export const migrateStandardToProtected = async (options: {
  backend: RemoteMemoryBackend;
  mmk: Buffer;
  now?: () => Date;
}): Promise<MigrationResult> => {
  const generations = await options.backend.listGenerations();
  // `listGenerations` is newest-first; copy oldest-first (see above).
  const standards = generations
    .filter((generation) => generation.privacyMode === 'standard')
    .sort((a, b) => a.generation - b.generation);
  const replicaByOriginal = new Map<string, MemoryGenerationMeta>();
  for (const generation of generations)
    if (generation.privacyMode === 'protected' && typeof generation.replicaOf === 'string')
      replicaByOriginal.set(generation.replicaOf, generation);

  // Read ONCE; every later create chains from the previous create's own result.
  let expectedParent = (await options.backend.getLatest())?.generation ?? null;
  let migrated = 0;
  let resumed = 0;
  for (const standard of standards) {
    const bundleBytes = await options.backend.getPayload(standard.backupId);
    verifyPayload(bundleBytes, standard.payloadSha256);

    const existing = replicaByOriginal.get(standard.backupId);
    if (existing) {
      // Resume: verify the earlier run's replica with THIS key before trusting it.
      const replicaPayload = await options.backend.getPayload(existing.backupId);
      verifyPayload(replicaPayload, existing.payloadSha256);
      verifyReplica(replicaPayload, existing.backupId, existing.wrappedDek, options.mmk, standard.payloadSha256);
      resumed += 1;
      continue;
    }

    const backupId = randomUUID();
    const dek = randomKey();
    const aad = protectedBundleAad(backupId);
    const sealed = seal(bundleBytes, dek, aad);
    const payload = Buffer.concat([
      sealed.nonce,
      sealed.ciphertext,
      sealed.tag,
    ]);
    const wrappedDek = wrapDekWithMmk(dek, options.mmk, backupId);
    // Verify the replica decrypts back to the ORIGINAL bytes before uploading it.
    verifyReplica(payload, backupId, wrappedDek, options.mmk, standard.payloadSha256);
    const meta = await options.backend.createGeneration({
      backupId,
      expectedParent,
      privacyMode: 'protected',
      payload,
      // Preserve the ORIGINAL generation's own format — re-encrypting a Standard
      // payload never changes whether the plaintext bundle inside it was v1 or v2.
      bundleFormatVersion: standard.bundleFormatVersion,
      cryptoVersion: CIPHER_VERSION,
      wrappedDek,
      replicaOf: standard.backupId,
      ...(options.now ? { now: options.now } : {}),
    });
    expectedParent = meta.generation;
    migrated += 1;
  }

  // All verified: retire Standard payloads and finalize.
  let retiredStandard = 0;
  for (const standard of standards) {
    await options.backend.retireGeneration(standard.backupId, options.now);
    retiredStandard += 1;
  }
  await options.backend.setPrivacyMode('protected');
  return {
    migrated,
    resumed,
    retiredStandard,
    finalized: true,
  };
};

const toResult = (meta: MemoryGenerationMeta): CloudBackupResult => ({
  generation: meta.generation,
  backupId: meta.backupId,
  privacyMode: meta.privacyMode,
  payloadSha256: meta.payloadSha256,
});

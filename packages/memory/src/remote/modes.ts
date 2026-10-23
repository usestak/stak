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
  retiredStandard: number;
  finalized: boolean;
};

/**
 * Migrate all Standard generations to Protected replacements, verify each decrypts
 * back to the original bytes, then retire the Standard payloads and finalize the
 * account as Protected. On any failure the account stays Standard and no Standard
 * payload is retired (no partial/false "Protected" state).
 */
export const migrateStandardToProtected = async (options: {
  backend: RemoteMemoryBackend;
  mmk: Buffer;
  now?: () => Date;
}): Promise<MigrationResult> => {
  const generations = await options.backend.listGenerations();
  // Oldest first (Task 13 fix round 2, Important-3): `listGenerations` returns
  // newest-first (both the in-memory store and the Supabase backend sort
  // `generation DESC`). Copying newest-first broke a v1→v2 account in two
  // ways: (a) a v2 Standard generation got copied BEFORE its earlier v1
  // siblings, and the server's v1-after-v2 gate (Critical-2) then rejected the
  // v1 copy that followed; (b) `createGeneration`'s own incrementing numbering
  // meant the LAST copy created — the oldest original — ended up with the
  // HIGHEST new generation number, silently making the oldest generation the
  // new "latest". Copying oldest-first preserves both the original format
  // order and which copy ends up actually being latest.
  const standards = generations
    .filter((generation) => generation.privacyMode === 'standard')
    .sort((a, b) => a.generation - b.generation);

  const retired: string[] = [];
  const replacements: MemoryGenerationMeta[] = [];
  for (const standard of standards) {
    const bundleBytes = await options.backend.getPayload(standard.backupId);
    verifyPayload(bundleBytes, standard.payloadSha256);
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
    const latest = await options.backend.getLatest();
    const meta = await options.backend.createGeneration({
      backupId,
      expectedParent: latest?.generation ?? null,
      privacyMode: 'protected',
      payload,
      // Preserve the ORIGINAL generation's own format — re-encrypting a Standard
      // payload never changes whether the plaintext bundle inside it was v1 or
      // v2 (see `standardCloudBackup`'s identical fix).
      bundleFormatVersion: standard.bundleFormatVersion,
      cryptoVersion: CIPHER_VERSION,
      wrappedDek,
      // See `CreateGenerationInput.isMigrationReplica`'s doc comment: no copy
      // order or retirement timing can satisfy the ordinary v1-after-v2 gate
      // once an account's history contains a higher-numbered v2 generation —
      // this verified, format-preserving replica of an EXISTING generation is
      // exempted from that gate (never from the expectedParent/conflict check).
      isMigrationReplica: true,
      ...(options.now ? { now: options.now } : {}),
    });
    // Verify the replacement decrypts back to the ORIGINAL bytes before trusting it.
    const check = unwrapDekWithMmk(wrappedDek, options.mmk, backupId);
    const roundTrip = open(splitPayload(payload), check, aad);
    if (hashBytes(roundTrip) !== standard.payloadSha256)
      throw new RemoteMemoryError(
        'integrity',
        'A migrated backup failed verification; account remains Standard.',
      );
    replacements.push(meta);
  }

  // All verified: retire Standard payloads and finalize.
  for (const standard of standards) {
    await options.backend.retireGeneration(standard.backupId, options.now);
    retired.push(standard.backupId);
  }
  await options.backend.setPrivacyMode('protected');
  return {
    migrated: replacements.length,
    retiredStandard: retired.length,
    finalized: true,
  };
};

const toResult = (meta: MemoryGenerationMeta): CloudBackupResult => ({
  generation: meta.generation,
  backupId: meta.backupId,
  privacyMode: meta.privacyMode,
  payloadSha256: meta.payloadSha256,
});

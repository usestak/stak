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
import {
  BUNDLE_FORMAT,
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
}): Promise<CloudBackupResult> => {
  await options.backend.ensureProfile(REMOTE_FORMAT_VERSION);
  const { bytes } = await bundleFromStore(options.stackHome);
  const latest = await options.backend.getLatest();
  const meta = await options.backend.createGeneration({
    backupId: randomUUID(),
    expectedParent: latest?.generation ?? null,
    privacyMode: 'standard',
    payload: bytes,
    bundleFormatVersion: BUNDLE_FORMAT,
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
}): Promise<CloudBackupResult> => {
  const { bytes: bundleBytes } = await bundleFromStore(options.stackHome);
  const backupId = randomUUID();
  const dek = randomKey();
  const sealed = seal(bundleBytes, dek, protectedBundleAad(backupId));
  const payload = Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]);
  const wrappedDek = wrapDekWithMmk(dek, options.mmk, backupId);
  const latest = await options.backend.getLatest();
  const meta = await options.backend.createGeneration({
    backupId,
    expectedParent: latest?.generation ?? null,
    privacyMode: 'protected',
    payload,
    bundleFormatVersion: BUNDLE_FORMAT,
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
  const standards = generations.filter(
    (generation) => generation.privacyMode === 'standard',
  );

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
      bundleFormatVersion: BUNDLE_FORMAT,
      cryptoVersion: CIPHER_VERSION,
      wrappedDek,
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

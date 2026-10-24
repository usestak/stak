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

import { hashBytes, readMemoryManifest, writeMemoryManifest } from '../store.js';
import type { CanonicalMainManifest } from '../canonical/domain.js';
import { convertV1BundleForRecover } from '../canonical/convert-v1.js';
import { isLocalStoreMigrated } from '../canonical/migrate.js';
import { writeCanonicalMain } from '../canonical/store.js';
import { readLocalRegistry, writeLocalRegistry } from '../project/registry-store.js';
import {
  bundleFromStore,
  parseBundle,
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

  // Spec §8.5 / §9.2: an old-format (v1) bundle recovered onto a store that is
  // ALREADY upgraded. Restoring it as-is would leave `canonical/main.json`
  // untouched (so the next push republishes current project Memory and the
  // rollback does nothing for projects) and put project items back into
  // `current.json` after migration. So convert it to canonical Memory instead.
  // A dry-run conversion runs FIRST: an identity conflict fails closed here,
  // before anything is written (never a partial recover).
  const bundle = parseBundle(bundleBytes);
  const convertV1 = !bundle.canonicalB64 && (await isLocalStoreMigrated(options.stackHome));
  if (convertV1)
    convertV1BundleForRecover(bundle, {
      localRegistry: await readLocalRegistry(options.stackHome),
      mint: () => 'prj_dryrun',
    });

  const restored = await restoreBundleToStore({
    bytes: bundleBytes,
    stackHome: options.stackHome,
  });
  // Phase 15B: reconcile the portable project registry the bundle carried (or lazily
  // migrate legacy identities when it carried none). Never creates a path binding.
  await reconcileRegistryAfterRecover({ stackHome: options.stackHome });
  if (convertV1) {
    // Against the reconciled registry, so Project IDs match what reconcile
    // recorded (snapshot first, local registry as the §9.2 fallback).
    const converted = convertV1BundleForRecover(bundle, {
      localRegistry: await readLocalRegistry(options.stackHome),
    });
    await writeLocalRegistry(options.stackHome, converted.registry);
    await writeCanonicalMain(options.stackHome, converted.main);
    // Same slimming as migration step D: `current.json` stays global-only.
    const manifest = await readMemoryManifest(options.stackHome);
    if (manifest)
      await writeMemoryManifest({
        stackHome: options.stackHome,
        manifest: { ...manifest, items: manifest.items.filter((item) => item.scope === 'global') },
      });
  }
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
  /** Replicas from an earlier interrupted run that this key could not open,
   * retired before re-replicating (Task 13 fix round 4). */
  retiredReplicas: number;
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
  "Protecting your Cloud Memory was interrupted before it finished, so STAK won't sync Memory until it does. Nothing was changed on this machine. Run `stak memory protect` again on any signed-in machine to finish it — if that machine doesn't hold the key from the interrupted run, protect safely redoes the copy with a new key.";

export const PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE =
  "Protecting your Cloud Memory was interrupted while it was finishing, so STAK won't sync Memory until it does. Nothing was changed on this machine. Run `stak memory protect` again on the machine that started it — only that machine holds the key for the protected copies already made.";

/** How to unlock Protected Memory on a device that doesn't hold the key. */
export const UNLOCK_PROTECTED_HINT =
  '`stak memory recover --passkey` or `stak memory recover --recovery-file <path>`';

export const ALREADY_PROTECTED_MESSAGE = `Your Cloud Memory is already Protected, so nothing was changed. Running protect again would replace this account's Memory key. To unlock Protected Memory on this device, run ${UNLOCK_PROTECTED_HINT}.`;

/**
 * Final review C1: refuse `stak memory protect` once the account is
 * Protected (and not mid-protect). Re-running it would generate and enroll a
 * NEW Memory key over the device's real one, which the account's generations
 * can't be opened with. Call before generating, enrolling or wrapping any key.
 */
export const assertNotAlreadyProtected = async (backend: RemoteMemoryBackend): Promise<void> => {
  if ((await backend.getProfile())?.privacyMode === 'protected')
    throw new RemoteMemoryError('already-protected', ALREADY_PROTECTED_MESSAGE);
};

/**
 * Committed Protected replicas whose original is no longer a committed
 * Standard generation — i.e. protect was interrupted AFTER it began retiring
 * originals (the finalize step). These can't be re-replicated, so only the key
 * that made them can finish the migration (Task 13 fix round 4).
 */
export const replicasNeedingOriginalKey = async (
  backend: RemoteMemoryBackend,
): Promise<MemoryGenerationMeta[]> => {
  const out: MemoryGenerationMeta[] = [];
  for (const generation of await backend.listGenerations()) {
    if (generation.privacyMode !== 'protected' || typeof generation.replicaOf !== 'string') continue;
    const original = await backend.getGenerationById(generation.replicaOf);
    if (!original || original.state !== 'committed' || original.privacyMode !== 'standard') out.push(generation);
  }
  return out;
};

/** The accurate fail-closed message for an interrupted protect. */
export const protectInProgressMessage = async (backend: RemoteMemoryBackend): Promise<string> =>
  (await replicasNeedingOriginalKey(backend)).length > 0
    ? PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE
    : PROTECT_IN_PROGRESS_MESSAGE;

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
 *  - `expectedParent` is CHAINED from this run's own previous create, never
 *    re-read per copy: a concurrent push landing mid-migration makes the next
 *    create conflict, aborting the migration, instead of being silently
 *    stranded as Standard plaintext behind a later replica.
 *  - Resumable: an original that already has a replica this MMK verifies (an
 *    earlier interrupted run on this device) is not copied again.
 *  - Oldest-first, so the newest original's replica is created last and is the
 *    account's latest after finalize.
 *
 * Task 13 fix round 4 (no lockout): when an existing replica can NOT be
 * verified with this MMK (an interrupted run on another device, or a lost
 * key), and the account is still Standard with EVERY original re-confirmed as
 * a committed Standard generation whose payload verifies, ALL existing
 * replicas are retired (keeping verifiable ones beside fresh copies could
 * leave an older original's replica as latest) and every original is
 * replicated again with this MMK. Originals are never touched until finalize.
 */
export const migrateStandardToProtected = async (options: {
  backend: RemoteMemoryBackend;
  mmk: Buffer;
  now?: () => Date;
}): Promise<MigrationResult> => {
  // Final review I5: read the commit counter FIRST, before listing — every
  // create chains from it, so a push landing anywhere after this point (even
  // during the long Phase 1 reads, before any copy exists) makes the first
  // create conflict instead of being stranded as Standard behind a replica.
  // Retiring never lowers the counter, so Phase 1b below doesn't move it.
  const initialHead =
    (await options.backend.getProfile())?.latestGeneration ??
    (await options.backend.getLatest())?.generation ??
    null;
  const generations = await options.backend.listGenerations();
  // `listGenerations` is newest-first; copy oldest-first (see above).
  const standards = generations
    .filter((generation) => generation.privacyMode === 'standard')
    .sort((a, b) => a.generation - b.generation);
  const replicaByOriginal = new Map<string, MemoryGenerationMeta>();
  for (const generation of generations)
    if (generation.privacyMode === 'protected' && typeof generation.replicaOf === 'string')
      replicaByOriginal.set(generation.replicaOf, generation);

  // Phase 0: replicas whose original is already retired (protect was
  // interrupted while finalizing) can't be redone — they must open with THIS
  // key, or only the machine that made them can finish (fail closed, nothing
  // changed).
  const standardIds = new Set(standards.map((g) => g.backupId));
  for (const generation of generations) {
    if (generation.privacyMode !== 'protected' || typeof generation.replicaOf !== 'string') continue;
    if (standardIds.has(generation.replicaOf)) continue;
    try {
      const payload = await options.backend.getPayload(generation.backupId);
      verifyPayload(payload, generation.payloadSha256);
      if (!generation.wrappedDek) throw new Error('missing wrapped key');
      const dek = unwrapDekWithMmk(generation.wrappedDek, options.mmk, generation.backupId);
      open(splitPayload(payload), dek, protectedBundleAad(generation.backupId));
    } catch {
      throw new RemoteMemoryError('protect-in-progress', PROTECT_NEEDS_ORIGINAL_KEY_MESSAGE);
    }
  }

  // Phase 1: read + verify every original; verify any existing replica with THIS key.
  const originalBytes = new Map<string, Uint8Array>();
  const verified = new Set<string>();
  let orphaned = false;
  for (const standard of standards) {
    const bundleBytes = await options.backend.getPayload(standard.backupId);
    verifyPayload(bundleBytes, standard.payloadSha256);
    originalBytes.set(standard.backupId, bundleBytes);
    const existing = replicaByOriginal.get(standard.backupId);
    if (!existing) continue;
    try {
      const replicaPayload = await options.backend.getPayload(existing.backupId);
      verifyPayload(replicaPayload, existing.payloadSha256);
      verifyReplica(replicaPayload, existing.backupId, existing.wrappedDek, options.mmk, standard.payloadSha256);
      verified.add(standard.backupId);
    } catch {
      orphaned = true;
    }
  }

  // Phase 1b (escape): retire unverifiable replicas, after re-confirming the originals.
  let retiredReplicas = 0;
  if (orphaned) {
    const profile = await options.backend.getProfile();
    if ((profile?.privacyMode ?? 'standard') !== 'standard')
      throw new RemoteMemoryError(
        'integrity',
        'Existing Protected copies cannot be opened with this key, and the account is no longer Standard; nothing was changed.',
      );
    for (const standard of standards) {
      const current = await options.backend.getGenerationById(standard.backupId);
      if (!current || current.state !== 'committed' || current.privacyMode !== 'standard')
        throw new RemoteMemoryError(
          'integrity',
          'An original Standard backup changed during protect; nothing was retired. Run `stak memory protect` again.',
        );
    }
    for (const standard of standards) {
      const existing = replicaByOriginal.get(standard.backupId);
      if (!existing) continue;
      await options.backend.retireGeneration(existing.backupId, options.now, { guarded: true });
      retiredReplicas += 1;
    }
    verified.clear();
  }

  // Every create chains from the counter read before listing (final review
  // I5), then from the previous create's own result. The profile's
  // `latestGeneration` is what the commit checks against.
  let expectedParent = initialHead;
  let migrated = 0;
  let resumed = 0;
  // original backupId -> the replica this run verified or created for it.
  const replicaFor = new Map<string, string>();
  for (const standard of standards) {
    if (verified.has(standard.backupId)) {
      replicaFor.set(standard.backupId, replicaByOriginal.get(standard.backupId)!.backupId);
      resumed += 1;
      continue;
    }
    const bundleBytes = originalBytes.get(standard.backupId) as Uint8Array;
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
    replicaFor.set(standard.backupId, meta.backupId);
    migrated += 1;
  }

  // All verified: retire Standard payloads and finalize. Task 13 fix round 5:
  // right before each original is retired, re-check BY backupId that its
  // replica is still committed (another device's protect may have retired it
  // as an orphan meanwhile) and abort otherwise; the retire itself is guarded
  // so the backend refuses it atomically if that changes in between.
  // Final review I5: nothing may have been committed since this run's last
  // create (or its initial read, when every copy was resumed). Checked before
  // retiring ANY original, so a push that landed after the last copy is never
  // stranded as Standard in a "Protected" account.
  if (((await options.backend.getProfile())?.latestGeneration ?? null) !== expectedParent)
    throw new RemoteMemoryError(
      'protect-in-progress',
      'Your Cloud Memory changed while protect was running (another machine pushed), so nothing was retired. Run `stak memory protect` again.',
    );
  let retiredStandard = 0;
  for (const standard of standards) {
    const replicaId = replicaFor.get(standard.backupId);
    const replica = replicaId ? await options.backend.getGenerationById(replicaId) : null;
    if (!replica || replica.state !== 'committed')
      throw new RemoteMemoryError(
        'protect-in-progress',
        'Another device changed the protected copies while protect was finishing; nothing more was retired. Run `stak memory protect` again.',
      );
    await options.backend.retireGeneration(standard.backupId, options.now, { guarded: true });
    retiredStandard += 1;
  }
  // Final review I5: last line of defence before finalizing — no committed
  // Standard generation may remain (one landing during the retires above).
  // Re-running protect on this machine copies it and finishes.
  if ((await options.backend.listGenerations()).some((g) => g.privacyMode === 'standard'))
    throw new RemoteMemoryError(
      'protect-in-progress',
      'Your Cloud Memory changed while protect was finishing (another machine pushed). Run `stak memory protect` again on this machine to finish.',
    );
  await options.backend.setPrivacyMode('protected');
  return {
    migrated,
    resumed,
    retiredReplicas,
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

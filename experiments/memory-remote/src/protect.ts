/**
 * protect / recover — the Option A end-to-end flow, offline.
 *
 * SPIKE ONLY. Conceptually this is what `stack memory protect` and
 * `stack memory recover` would drive, but NOTHING here is wired into the real
 * CLI. It composes the four separated concerns:
 *   MemoryBackupCodec  →  MemoryCipher  →  RecoveryKeyProvider  →  RemoteMemoryBackend
 *
 * protect():  read Phase 14A store → canonical bundle → random per-backup DEK →
 *             AEAD-seal the bundle (routing metadata as AAD) → wrap the DEK under
 *             a KEK derived from the recovery key → upload ONLY ciphertext + the
 *             wrapped-key record + minimal routing metadata.
 * recover():  on a new machine, sign in → list backups → pick the newest (with a
 *             rollback high-water-mark check) → fetch → verify ciphertext hash →
 *             unwrap the DEK with the recovery key → decrypt → rebuild the store
 *             byte-exactly via Phase 14A.
 *
 * The remote backend never receives the recovery key, the KEK, the DEK, or any
 * plaintext. Account/auth access alone therefore cannot decrypt a backup.
 */
import { randomUUID } from 'node:crypto';

import { hashBytes } from '@stack/memory';

import { bundleFromStore, restoreBundleToStore } from './bundle-codec.js';
import {
  CIPHER_VERSION,
  open,
  randomKey,
  seal,
  type SealedBytes,
} from './cipher.js';
import {
  type RemoteBackupRecord,
  type RemoteMemoryBackend,
  type RemoteObject,
} from './backend.js';
import { unwrapDek, wrapDek } from './recovery-key.js';

/** Structured, plaintext-free telemetry. Only safe routing fields ever appear. */
export type SpikeEvent =
  | { phase: 'bundle'; objects: number }
  | { phase: 'seal'; ciphertextSha256: string }
  | { phase: 'upload'; backupId: string; generation: number }
  | { phase: 'select'; backupId: string; generation: number }
  | { phase: 'verify-ciphertext'; ok: boolean }
  | { phase: 'unwrap'; ok: boolean }
  | { phase: 'decrypt'; ok: boolean }
  | { phase: 'restore'; objects: number };

export type SpikeLogger = (event: SpikeEvent) => void;
const noopLogger: SpikeLogger = () => undefined;

export class ProtectError extends Error {
  constructor(
    public readonly code:
      | 'rollback-detected'
      | 'ciphertext-corrupt'
      | 'no-backups'
      | 'bundle-integrity',
    message: string,
  ) {
    super(message);
    this.name = 'ProtectError';
  }
}

type EnvelopeHeader = {
  v: string;
  backupId: string;
  backupGeneration: number;
  parentBackupId: string | null;
  createdAt: string;
};

/** Canonical AAD binding the ciphertext to its routing metadata (no plaintext). */
const envelopeAad = (header: EnvelopeHeader): Buffer =>
  Buffer.from(
    JSON.stringify({
      v: header.v,
      backupId: header.backupId,
      backupGeneration: header.backupGeneration,
      parentBackupId: header.parentBackupId,
      createdAt: header.createdAt,
    }),
    'utf8',
  );

/** Canonical AAD binding a wrapped-key record to its backup id. */
const wrapAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ purpose: 'wrap-dek', backupId }), 'utf8');

const ciphertextDigest = (sealed: SealedBytes): string =>
  hashBytes(Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]));

const toRemoteObject = (
  locator: string,
  sealed: SealedBytes,
): RemoteObject => ({
  locator,
  nonceB64: sealed.nonce.toString('base64'),
  ciphertextB64: sealed.ciphertext.toString('base64'),
  tagB64: sealed.tag.toString('base64'),
});

const fromRemoteObject = (object: RemoteObject): SealedBytes => ({
  nonce: Buffer.from(object.nonceB64, 'base64'),
  ciphertext: Buffer.from(object.ciphertextB64, 'base64'),
  tag: Buffer.from(object.tagB64, 'base64'),
});

export type ProtectResult = {
  backupId: string;
  generation: number;
  ciphertextSha256: string;
  parentBackupId: string | null;
};

/**
 * Back up the current Phase 14A store in `stackHome` to `backend`, encrypted
 * under a DEK wrapped by `recoveryKey`. `generation` should strictly increase per
 * user; `parentBackupId` links lineage for rollback reasoning.
 */
export const protect = async (options: {
  stackHome: string;
  backend: RemoteMemoryBackend;
  userId: string;
  recoveryKey: string;
  generation: number;
  parentBackupId?: string | null;
  now?: () => Date;
  log?: SpikeLogger;
}): Promise<ProtectResult> => {
  const log = options.log ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const parentBackupId = options.parentBackupId ?? null;

  const { bytes: bundleBytes, bundle } = await bundleFromStore(
    options.stackHome,
  );
  log({ phase: 'bundle', objects: bundle.objects.length });

  const backupId = randomUUID();
  const createdAt = now().toISOString();
  const header: EnvelopeHeader = {
    v: CIPHER_VERSION,
    backupId,
    backupGeneration: options.generation,
    parentBackupId,
    createdAt,
  };

  const dek = randomKey();
  const sealed = seal(bundleBytes, dek, envelopeAad(header));
  const ciphertextSha256 = ciphertextDigest(sealed);
  log({ phase: 'seal', ciphertextSha256 });

  const wrappedKeyRecord = await wrapDek({
    dek,
    recoveryKey: options.recoveryKey,
    aad: wrapAad(backupId),
  });

  const locator = `mem/${options.userId}/${backupId}`;
  await options.backend.putObject(toRemoteObject(locator, sealed));
  const record: RemoteBackupRecord = {
    userId: options.userId,
    backupId,
    createdAt,
    ciphertextLocator: locator,
    ciphertextSha256,
    cryptoVersion: CIPHER_VERSION,
    wrappedKeyRecord,
    backupGeneration: options.generation,
    parentBackupId,
  };
  await options.backend.putRecord(record);
  log({ phase: 'upload', backupId, generation: options.generation });

  return {
    backupId,
    generation: options.generation,
    ciphertextSha256,
    parentBackupId,
  };
};

export type RecoverResult = {
  backupId: string;
  generation: number;
  objects: number;
  manifestSha256: string;
};

/**
 * Recover the newest backup for `userId` into `stackHome` (which may be empty —
 * the new-machine case). `minGeneration` is a rollback high-water mark: if the
 * newest available backup is older than the last generation this user is known to
 * have created, recovery refuses rather than silently restoring stale memory.
 */
export const recover = async (options: {
  stackHome: string;
  backend: RemoteMemoryBackend;
  userId: string;
  recoveryKey: string;
  backupId?: string;
  minGeneration?: number;
  log?: SpikeLogger;
}): Promise<RecoverResult> => {
  const log = options.log ?? noopLogger;

  const record = await selectRecord(options);
  log({
    phase: 'select',
    backupId: record.backupId,
    generation: record.backupGeneration,
  });

  if (
    options.minGeneration !== undefined &&
    record.backupGeneration < options.minGeneration
  )
    throw new ProtectError(
      'rollback-detected',
      `Newest backup generation ${record.backupGeneration} is older than the ` +
        `expected minimum ${options.minGeneration}; refusing to restore stale memory.`,
    );

  const object = await options.backend.getObject(record.ciphertextLocator);
  const sealed = fromRemoteObject(object);
  const digestOk = ciphertextDigest(sealed) === record.ciphertextSha256;
  log({ phase: 'verify-ciphertext', ok: digestOk });
  if (!digestOk)
    throw new ProtectError(
      'ciphertext-corrupt',
      'Remote ciphertext failed its integrity hash; refusing to decrypt.',
    );

  const dek = await unwrapDek({
    record: record.wrappedKeyRecord,
    recoveryKey: options.recoveryKey,
    aad: wrapAad(record.backupId),
  });
  log({ phase: 'unwrap', ok: true });

  const header: EnvelopeHeader = {
    v: record.cryptoVersion,
    backupId: record.backupId,
    backupGeneration: record.backupGeneration,
    parentBackupId: record.parentBackupId,
    createdAt: record.createdAt,
  };
  const bundleBytes = open(sealed, dek, envelopeAad(header));
  log({ phase: 'decrypt', ok: true });

  const restored = await restoreBundleToStore({
    bytes: bundleBytes,
    stackHome: options.stackHome,
  });
  log({ phase: 'restore', objects: restored.objects });

  return {
    backupId: record.backupId,
    generation: record.backupGeneration,
    objects: restored.objects,
    manifestSha256: restored.manifestSha256,
  };
};

const selectRecord = async (options: {
  backend: RemoteMemoryBackend;
  userId: string;
  backupId?: string;
}): Promise<RemoteBackupRecord> => {
  if (options.backupId !== undefined)
    return options.backend.getRecord(options.userId, options.backupId);
  const records = await options.backend.listRecords(options.userId);
  const newest = records[0];
  if (!newest)
    throw new ProtectError('no-backups', 'No backups exist for this user.');
  return newest;
};

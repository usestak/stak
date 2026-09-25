/**
 * Standard vs Protected backup modes (Phase 14B1).
 *
 * SPIKE ONLY. Both modes are first-class product choices; neither is "insecure".
 *
 *  STANDARD  — optimizes for simplicity. The canonical bundle is stored so Stack
 *    Cloud infrastructure is technically CAPABLE of reading it. Still strictly
 *    private: per-user isolation, versioning, integrity, size bounds, never public,
 *    never shared. NOT end-to-end encrypted; documented honestly.
 *
 *  PROTECTED — opt-in client-side encryption. The bundle is AEAD-encrypted under a
 *    per-backup DEK, the DEK is wrapped by the MMK, and only ciphertext + a wrapped
 *    DEK + minimal metadata are stored. Stack Cloud can never read it.
 *
 * A single versioned remote record shape carries both, without mixing semantics.
 */
import { hashBytes } from '@stack/memory';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { bundleFromStore, restoreBundleToStore } from './bundle-codec.js';
import {
  CIPHER_VERSION,
  open,
  randomKey,
  seal,
  type SealedBytes,
} from './cipher.js';
import { unwrapDekWithMmk, wrapDekWithMmk, type MmkKeyring } from './mmk.js';

/** Reject implausibly large payloads (synthetic memory is small text). */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const REMOTE_FORMAT_VERSION = 'stack-mem-remote-v1' as const;

export type PrivacyMode = 'standard' | 'protected';

const wrappedDekSchema = z.object({
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});

export const modeRecordSchema = z.object({
  backupId: z.string().min(1),
  userId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  privacyMode: z.enum(['standard', 'protected']),
  payloadLocator: z.string().min(1),
  payloadSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  formatVersion: z.literal(REMOTE_FORMAT_VERSION),
  parentGeneration: z.number().int().nonnegative().nullable(),
  // Protected-only fields:
  cryptoVersion: z.string().min(1).optional(),
  wrappedDek: wrappedDekSchema.optional(),
  mmkId: z.string().min(1).optional(),
});
export type ModeRecord = z.infer<typeof modeRecordSchema>;

export class ModeError extends Error {
  constructor(
    public readonly code:
      | 'not-found'
      | 'forbidden'
      | 'too-large'
      | 'integrity'
      | 'duplicate'
      | 'not-protected'
      | 'migration-incomplete',
    message: string,
  ) {
    super(message);
    this.name = 'ModeError';
  }
}

/** A stored payload: bytes are a plaintext bundle (standard) or ciphertext (protected). */
export type StoredPayload = {
  locator: string;
  ownerUserId: string;
  bytesB64: string;
};

export interface ModeBackend {
  putPayload(userId: string, locator: string, bytes: Uint8Array): Promise<void>;
  getPayload(userId: string, locator: string): Promise<Uint8Array>;
  deletePayload(userId: string, locator: string): Promise<void>;
  putRecord(record: ModeRecord): Promise<void>;
  getRecord(userId: string, backupId: string): Promise<ModeRecord>;
  listRecords(userId: string): Promise<ModeRecord[]>;
  putKeyring(userId: string, keyring: MmkKeyring): Promise<void>;
  getKeyring(userId: string): Promise<MmkKeyring | null>;
  setAccountMode(userId: string, mode: PrivacyMode): Promise<void>;
  getAccountMode(userId: string): Promise<PrivacyMode>;
}

/** In-memory backend enforcing per-user isolation, size bounds, versioning. */
export class InMemoryModeBackend implements ModeBackend {
  private readonly payloads = new Map<string, StoredPayload>();
  private readonly records = new Map<string, ModeRecord>();
  private readonly keyrings = new Map<string, MmkKeyring>();
  private readonly accountMode = new Map<string, PrivacyMode>();

  private rkey(userId: string, backupId: string): string {
    return `${userId}\u0000${backupId}`;
  }

  putPayload(
    userId: string,
    locator: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.byteLength > MAX_PAYLOAD_BYTES)
      throw new ModeError(
        'too-large',
        'Payload exceeds the maximum allowed size.',
      );
    this.payloads.set(locator, {
      locator,
      ownerUserId: userId,
      bytesB64: Buffer.from(bytes).toString('base64'),
    });
    return Promise.resolve();
  }

  getPayload(userId: string, locator: string): Promise<Uint8Array> {
    const payload = this.payloads.get(locator);
    if (!payload) throw new ModeError('not-found', 'Payload not found.');
    if (payload.ownerUserId !== userId)
      throw new ModeError('forbidden', 'This payload belongs to another user.');
    return Promise.resolve(Buffer.from(payload.bytesB64, 'base64'));
  }

  deletePayload(userId: string, locator: string): Promise<void> {
    const payload = this.payloads.get(locator);
    if (payload && payload.ownerUserId === userId)
      this.payloads.delete(locator);
    return Promise.resolve();
  }

  putRecord(record: ModeRecord): Promise<void> {
    const parsed = modeRecordSchema.parse(record);
    const key = this.rkey(parsed.userId, parsed.backupId);
    if (this.records.has(key))
      throw new ModeError('duplicate', 'Backup id already exists.');
    this.records.set(key, parsed);
    return Promise.resolve();
  }

  getRecord(userId: string, backupId: string): Promise<ModeRecord> {
    const record = this.records.get(this.rkey(userId, backupId));
    if (!record) throw new ModeError('not-found', 'Record not found.');
    return Promise.resolve(record);
  }

  listRecords(userId: string): Promise<ModeRecord[]> {
    const mine = [...this.records.values()].filter(
      (record) => record.userId === userId,
    );
    mine.sort((a, b) => b.generation - a.generation);
    return Promise.resolve(mine);
  }

  putKeyring(userId: string, keyring: MmkKeyring): Promise<void> {
    this.keyrings.set(userId, keyring);
    return Promise.resolve();
  }

  getKeyring(userId: string): Promise<MmkKeyring | null> {
    return Promise.resolve(this.keyrings.get(userId) ?? null);
  }

  setAccountMode(userId: string, mode: PrivacyMode): Promise<void> {
    this.accountMode.set(userId, mode);
    return Promise.resolve();
  }

  getAccountMode(userId: string): Promise<PrivacyMode> {
    return Promise.resolve(this.accountMode.get(userId) ?? 'standard');
  }

  /** Test-only: does a payload still exist? */
  hasPayload(locator: string): boolean {
    return this.payloads.has(locator);
  }

  /** Test-only: corrupt a stored payload. */
  corruptPayload(locator: string): void {
    const payload = this.payloads.get(locator);
    if (!payload) return;
    const bytes = Buffer.from(payload.bytesB64, 'base64');
    const first = bytes[0];
    if (first !== undefined) bytes[0] = first ^ 0xff;
    this.payloads.set(locator, {
      ...payload,
      bytesB64: bytes.toString('base64'),
    });
  }
}

// --- Standard ------------------------------------------------------------

const nextGeneration = (
  records: ModeRecord[],
): { generation: number; parent: number | null } => {
  const top = records[0];
  return top
    ? { generation: top.generation + 1, parent: top.generation }
    : { generation: 0, parent: null };
};

export const standardBackup = async (options: {
  stackHome: string;
  backend: ModeBackend;
  userId: string;
  now?: () => Date;
}): Promise<ModeRecord> => {
  const { bytes } = await bundleFromStore(options.stackHome);
  const { generation, parent } = nextGeneration(
    await options.backend.listRecords(options.userId),
  );
  const backupId = randomUUID();
  const locator = `std/${options.userId}/${backupId}`;
  await options.backend.putPayload(options.userId, locator, bytes);
  const record: ModeRecord = {
    backupId,
    userId: options.userId,
    generation,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    privacyMode: 'standard',
    payloadLocator: locator,
    payloadSha256: hashBytes(bytes),
    formatVersion: REMOTE_FORMAT_VERSION,
    parentGeneration: parent,
  };
  await options.backend.putRecord(record);
  return record;
};

const verifyPayload = (bytes: Uint8Array, expectedSha: string): void => {
  if (hashBytes(bytes) !== expectedSha)
    throw new ModeError('integrity', 'Payload failed its integrity hash.');
};

export const standardRecover = async (options: {
  stackHome: string;
  backend: ModeBackend;
  userId: string;
}): Promise<{ record: ModeRecord; objects: number }> => {
  const record = await newestRecord(
    options.backend,
    options.userId,
    'standard',
  );
  const bytes = await options.backend.getPayload(
    options.userId,
    record.payloadLocator,
  );
  verifyPayload(bytes, record.payloadSha256);
  const restored = await restoreBundleToStore({
    bytes,
    stackHome: options.stackHome,
  });
  return { record, objects: restored.objects };
};

// --- Protected -----------------------------------------------------------

const protectedAad = (record: {
  backupId: string;
  generation: number;
  userId: string;
}): Buffer =>
  Buffer.from(
    JSON.stringify({
      v: CIPHER_VERSION,
      privacyMode: 'protected',
      backupId: record.backupId,
      generation: record.generation,
      userId: record.userId,
    }),
    'utf8',
  );

export const protectedBackup = async (options: {
  stackHome: string;
  backend: ModeBackend;
  userId: string;
  mmk: Buffer;
  keyring: MmkKeyring;
  now?: () => Date;
}): Promise<ModeRecord> => {
  const { bytes: bundleBytes } = await bundleFromStore(options.stackHome);
  const { generation, parent } = nextGeneration(
    await options.backend.listRecords(options.userId),
  );
  const backupId = randomUUID();
  const dek = randomKey();
  const sealed = seal(
    bundleBytes,
    dek,
    protectedAad({ backupId, generation, userId: options.userId }),
  );
  const payload = Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]);
  const locator = `prot/${options.userId}/${backupId}`;
  await options.backend.putPayload(options.userId, locator, payload);
  const record: ModeRecord = {
    backupId,
    userId: options.userId,
    generation,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    privacyMode: 'protected',
    payloadLocator: locator,
    payloadSha256: hashBytes(payload),
    formatVersion: REMOTE_FORMAT_VERSION,
    parentGeneration: parent,
    cryptoVersion: CIPHER_VERSION,
    wrappedDek: wrapDekWithMmk(dek, options.mmk, backupId),
    mmkId: options.keyring.mmkId,
  };
  await options.backend.putRecord(record);
  return record;
};

const splitPayload = (payload: Uint8Array): SealedBytes => {
  const buf = Buffer.from(payload);
  return {
    nonce: buf.subarray(0, 12),
    ciphertext: buf.subarray(12, buf.length - 16),
    tag: buf.subarray(buf.length - 16),
  };
};

export const protectedRecover = async (options: {
  stackHome: string;
  backend: ModeBackend;
  userId: string;
  mmk: Buffer;
}): Promise<{ record: ModeRecord; objects: number }> => {
  const record = await newestRecord(
    options.backend,
    options.userId,
    'protected',
  );
  if (!record.wrappedDek || !record.cryptoVersion)
    throw new ModeError(
      'not-protected',
      'Record is missing protected-mode fields.',
    );
  const payload = await options.backend.getPayload(
    options.userId,
    record.payloadLocator,
  );
  verifyPayload(payload, record.payloadSha256);
  const dek = unwrapDekWithMmk(record.wrappedDek, options.mmk, record.backupId);
  const bundleBytes = open(
    splitPayload(payload),
    dek,
    protectedAad({
      backupId: record.backupId,
      generation: record.generation,
      userId: record.userId,
    }),
  );
  const restored = await restoreBundleToStore({
    bytes: bundleBytes,
    stackHome: options.stackHome,
  });
  return { record, objects: restored.objects };
};

const newestRecord = async (
  backend: ModeBackend,
  userId: string,
  mode: PrivacyMode,
): Promise<ModeRecord> => {
  const record = (await backend.listRecords(userId)).find(
    (candidate) => candidate.privacyMode === mode,
  );
  if (!record)
    throw new ModeError('not-found', `No ${mode} backup found for this user.`);
  return record;
};

// --- Migration: Standard → Protected -------------------------------------

export type MigrationResult = {
  migrated: number;
  removedStandardPayloads: number;
  finalized: boolean;
};

/**
 * Migrate all Standard backups to Protected, then finalize the account as
 * Protected — but ONLY after every replacement is verified to decrypt back to the
 * original bytes. On any failure the account is NOT marked Protected and existing
 * Standard payloads are left intact (no partial/false "Protected" state).
 */
export const migrateStandardToProtected = async (options: {
  backend: ModeBackend;
  userId: string;
  mmk: Buffer;
  keyring: MmkKeyring;
  now?: () => Date;
}): Promise<MigrationResult> => {
  const now = options.now ?? (() => new Date());
  const standards = (await options.backend.listRecords(options.userId)).filter(
    (record) => record.privacyMode === 'standard',
  );

  const replacements: { standard: ModeRecord; protectedRecord: ModeRecord }[] =
    [];
  for (const standard of standards) {
    const bundleBytes = await options.backend.getPayload(
      options.userId,
      standard.payloadLocator,
    );
    verifyPayload(bundleBytes, standard.payloadSha256);
    const backupId = randomUUID();
    const dek = randomKey();
    const aad = protectedAad({
      backupId,
      generation: standard.generation,
      userId: options.userId,
    });
    const sealed = seal(bundleBytes, dek, aad);
    const payload = Buffer.concat([
      sealed.nonce,
      sealed.ciphertext,
      sealed.tag,
    ]);
    const locator = `prot/${options.userId}/${backupId}`;
    const wrappedDek = wrapDekWithMmk(dek, options.mmk, backupId);
    await options.backend.putPayload(options.userId, locator, payload);
    const protectedRecord: ModeRecord = {
      backupId,
      userId: options.userId,
      generation: standard.generation,
      createdAt: now().toISOString(),
      privacyMode: 'protected',
      payloadLocator: locator,
      payloadSha256: hashBytes(payload),
      formatVersion: REMOTE_FORMAT_VERSION,
      parentGeneration: standard.parentGeneration,
      cryptoVersion: CIPHER_VERSION,
      wrappedDek,
      mmkId: options.keyring.mmkId,
    };
    await options.backend.putRecord(protectedRecord);

    // Verify the replacement decrypts back to the ORIGINAL bytes before trusting it.
    const check = unwrapDekWithMmk(wrappedDek, options.mmk, backupId);
    const roundTrip = open(splitPayload(payload), check, aad);
    if (hashBytes(roundTrip) !== standard.payloadSha256)
      throw new ModeError(
        'migration-incomplete',
        'A migrated backup failed verification.',
      );
    replacements.push({ standard, protectedRecord });
  }

  // Only now, all verified: remove Standard plaintext payloads and finalize.
  let removed = 0;
  for (const { standard } of replacements) {
    await options.backend.deletePayload(
      options.userId,
      standard.payloadLocator,
    );
    removed += 1;
  }
  await options.backend.setAccountMode(options.userId, 'protected');
  return {
    migrated: replacements.length,
    removedStandardPayloads: removed,
    finalized: true,
  };
};

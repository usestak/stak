/**
 * RemoteMemoryBackend — the pluggable transport boundary for the spike.
 *
 * SPIKE ONLY. Stack owns the domain model (bundle, cipher, recovery); a backend
 * is a replaceable adapter that stores ONLY opaque ciphertext plus minimal
 * routing metadata. Future real backends (StackCloud*, SealWalrus*, WalrusMemory*)
 * implement this same interface. A backend never receives keys or plaintext.
 *
 * Metadata model (deliberately minimal — see the spike doc, §"Metadata model"):
 * a remote record carries user id, backup id, created-at, ciphertext locator,
 * ciphertext SHA-256, crypto version, the wrapped-key record, the backup
 * generation, and a parent backup id for lineage. It carries NO project names,
 * repo/file names, memory text, Git identities, or logical IDs — those live only
 * inside the encrypted bundle.
 */
import { z } from 'zod';

import { WRAP_SCHEME } from './recovery-key.js';

const wrappedKeyRecordSchema = z.object({
  scheme: z.literal(WRAP_SCHEME),
  kdf: z.object({
    name: z.literal('scrypt'),
    N: z.number(),
    r: z.number(),
    p: z.number(),
    keyLen: z.number(),
  }),
  saltB64: z.string(),
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});

/** Opaque sealed blob as stored remotely. No field reveals plaintext. */
export const remoteObjectSchema = z.object({
  locator: z.string().min(1),
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});
export type RemoteObject = z.infer<typeof remoteObjectSchema>;

/** Minimal remote routing record. No plaintext, no project/file identifiers. */
export const remoteBackupRecordSchema = z.object({
  userId: z.string().min(1),
  backupId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  ciphertextLocator: z.string().min(1),
  ciphertextSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  cryptoVersion: z.string().min(1),
  wrappedKeyRecord: wrappedKeyRecordSchema,
  backupGeneration: z.number().int().nonnegative(),
  parentBackupId: z.string().min(1).nullable(),
});
export type RemoteBackupRecord = z.infer<typeof remoteBackupRecordSchema>;

export class BackendError extends Error {
  constructor(
    public readonly code:
      'duplicate-backup' | 'object-not-found' | 'record-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface RemoteMemoryBackend {
  /** Store an opaque sealed object. Idempotent by locator. */
  putObject(object: RemoteObject): Promise<void>;
  getObject(locator: string): Promise<RemoteObject>;
  /** Commit a backup record. Rejects a duplicate backupId (idempotency guard). */
  putRecord(record: RemoteBackupRecord): Promise<void>;
  getRecord(userId: string, backupId: string): Promise<RemoteBackupRecord>;
  /** All records for a user, newest generation first. */
  listRecords(userId: string): Promise<RemoteBackupRecord[]>;
  /** Delete a backup's record and its object (deletion semantics test). */
  deleteBackup(userId: string, backupId: string): Promise<void>;
}

/**
 * In-memory backend that simulates a remote store. Proves the transport contract
 * offline: it holds only what `RemoteObject`/`RemoteBackupRecord` allow, so a
 * test can assert the provider never sees plaintext or keys.
 */
export class InMemoryRemoteBackend implements RemoteMemoryBackend {
  private readonly objects = new Map<string, RemoteObject>();
  private readonly records = new Map<string, RemoteBackupRecord>();

  private key(userId: string, backupId: string): string {
    return `${userId}\u0000${backupId}`;
  }

  putObject(object: RemoteObject): Promise<void> {
    this.objects.set(object.locator, remoteObjectSchema.parse(object));
    return Promise.resolve();
  }

  getObject(locator: string): Promise<RemoteObject> {
    const object = this.objects.get(locator);
    if (!object)
      throw new BackendError('object-not-found', 'Remote object not found.');
    return Promise.resolve(object);
  }

  putRecord(record: RemoteBackupRecord): Promise<void> {
    const parsed = remoteBackupRecordSchema.parse(record);
    const key = this.key(parsed.userId, parsed.backupId);
    if (this.records.has(key))
      throw new BackendError(
        'duplicate-backup',
        `A backup with id ${parsed.backupId} already exists.`,
      );
    this.records.set(key, parsed);
    return Promise.resolve();
  }

  getRecord(userId: string, backupId: string): Promise<RemoteBackupRecord> {
    const record = this.records.get(this.key(userId, backupId));
    if (!record)
      throw new BackendError('record-not-found', 'Remote record not found.');
    return Promise.resolve(record);
  }

  listRecords(userId: string): Promise<RemoteBackupRecord[]> {
    const mine = [...this.records.values()].filter(
      (record) => record.userId === userId,
    );
    mine.sort((a, b) => b.backupGeneration - a.backupGeneration);
    return Promise.resolve(mine);
  }

  deleteBackup(userId: string, backupId: string): Promise<void> {
    const record = this.records.get(this.key(userId, backupId));
    if (record) {
      this.objects.delete(record.ciphertextLocator);
      this.records.delete(this.key(userId, backupId));
    }
    return Promise.resolve();
  }

  /** Test-only: raw view, to prove no plaintext/keys are held here. */
  inspect(): { objects: RemoteObject[]; records: RemoteBackupRecord[] } {
    return {
      objects: [...this.objects.values()],
      records: [...this.records.values()],
    };
  }

  /** Test-only: corrupt a stored object's ciphertext (corruption scenario). */
  corruptObject(locator: string): void {
    const object = this.objects.get(locator);
    if (!object) return;
    const bytes = Buffer.from(object.ciphertextB64, 'base64');
    const first = bytes[0];
    if (first !== undefined) bytes[0] = first ^ 0xff;
    this.objects.set(locator, {
      ...object,
      ciphertextB64: bytes.toString('base64'),
    });
  }

  /** Test-only: truncate a stored object's ciphertext (truncation scenario). */
  truncateObject(locator: string, keepBytes: number): void {
    const object = this.objects.get(locator);
    if (!object) return;
    const bytes = Buffer.from(object.ciphertextB64, 'base64').subarray(
      0,
      keepBytes,
    );
    this.objects.set(locator, {
      ...object,
      ciphertextB64: Buffer.from(bytes).toString('base64'),
    });
  }

  /** Test-only: tamper with an authenticated metadata field on a record. */
  tamperRecord(
    userId: string,
    backupId: string,
    patch: Partial<RemoteBackupRecord>,
  ): void {
    const key = this.key(userId, backupId);
    const record = this.records.get(key);
    if (!record) return;
    this.records.set(key, { ...record, ...patch });
  }
}

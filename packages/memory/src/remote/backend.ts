/**
 * RemoteMemoryBackend — the production domain contract for remote Memory.
 *
 * Stack owns the Memory domain; storage providers implement this interface. It is
 * bound to ONE authenticated user (the identity is never taken from method
 * arguments — a real backend derives it from the session/token). Operations cover:
 * versioned immutable backup generations with optimistic-concurrency commit,
 * payload storage/retrieval, retire/soft-delete, recovery-method envelope storage,
 * and a one-time recovery-session relay.
 *
 * Two payload shapes flow through the SAME contract: a Standard payload is the
 * canonical bundle (server-readable by product definition); a Protected payload is
 * AEAD ciphertext (`nonce||ciphertext||tag`) plus a wrapped DEK — the server can
 * never read it. No plaintext project/file identifiers appear in metadata.
 */
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { WrappedDek } from './mmk.js';

/** Explicit size bounds — reject pathological payloads. */
export const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
export const REMOTE_FORMAT_VERSION = 'stack-mem-remote-v1' as const;

export type PrivacyMode = 'standard' | 'protected';
export type GenerationState = 'pending' | 'committed' | 'retired';

export const wrappedDekSchema = z.object({
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});

export type MemoryProfile = {
  userId: string;
  privacyMode: PrivacyMode;
  latestGeneration: number | null;
  formatVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryGenerationMeta = {
  backupId: string;
  userId: string;
  generation: number;
  parentGeneration: number | null;
  privacyMode: PrivacyMode;
  createdAt: string;
  payloadSha256: string;
  payloadBytes: number;
  bundleFormatVersion: string;
  cryptoVersion?: string;
  wrappedDek?: WrappedDek;
  state: GenerationState;
  softDeletedAt?: string | null;
};

export type RecoveryMethodRecord = {
  methodId: string;
  userId: string;
  type: 'passkey' | 'recovery-file' | 'trusted-device';
  label: string;
  publicIdentifier: string | null;
  mmkWrapper: unknown; // opaque MmkWrapper JSON (server never interprets it)
  cryptoVersion: string;
  createdAt: string;
  revokedAt: string | null;
};

export type RecoverySessionRecord = {
  sessionId: string;
  userId: string;
  direction: 'recovery' | 'enrollment';
  session: unknown; // opaque public RecoverySession JSON
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  envelope: unknown | null; // opaque BridgeEnvelope JSON
};

export class RemoteMemoryError extends Error {
  constructor(
    public readonly code:
      | 'conflict'
      | 'not-found'
      | 'too-large'
      | 'integrity'
      | 'not-protected'
      | 'mmk-required'
      | 'session-consumed'
      | 'session-expired'
      | 'no-envelope',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteMemoryError';
  }
}

export type CreateGenerationInput = {
  /** Client-generated id; binds the payload/DEK and doubles as an idempotency key. */
  backupId: string;
  expectedParent: number | null;
  privacyMode: PrivacyMode;
  payload: Uint8Array;
  bundleFormatVersion: string;
  cryptoVersion?: string;
  wrappedDek?: WrappedDek;
  now?: () => Date;
};

export type AddRecoveryMethodInput = {
  type: 'passkey' | 'recovery-file' | 'trusted-device';
  label: string;
  publicIdentifier?: string | null;
  mmkWrapper: unknown;
  cryptoVersion: string;
};

export type CreateRecoverySessionInput = {
  sessionId: string;
  direction: 'recovery' | 'enrollment';
  session: unknown;
  expiresAt: string;
};

/** Per-user remote Memory backend. Identity is bound at construction, never passed. */
export interface RemoteMemoryBackend {
  getProfile(): Promise<MemoryProfile | null>;
  ensureProfile(formatVersion: string): Promise<MemoryProfile>;
  setPrivacyMode(mode: PrivacyMode): Promise<MemoryProfile>;

  listGenerations(): Promise<MemoryGenerationMeta[]>;
  getLatest(): Promise<MemoryGenerationMeta | null>;
  getGeneration(generation: number): Promise<MemoryGenerationMeta | null>;
  getGenerationById(backupId: string): Promise<MemoryGenerationMeta | null>;
  /** Transactional: prepare → store payload → commit → advance latest. */
  createGeneration(input: CreateGenerationInput): Promise<MemoryGenerationMeta>;
  getPayload(backupId: string): Promise<Uint8Array>;
  retireGeneration(backupId: string, now?: () => Date): Promise<void>;
  /**
   * Every backup id for this user, INCLUDING already-retired ones (P3). Delete Cloud Memory
   * uses this so a retry can re-remove a payload orphaned by an earlier partial failure —
   * `listGenerations` (committed-only) would hide a retired-but-not-yet-purged generation.
   */
  listAllBackupIds(): Promise<string[]>;

  addRecoveryMethod(
    input: AddRecoveryMethodInput,
    now?: () => Date,
  ): Promise<RecoveryMethodRecord>;
  listRecoveryMethods(): Promise<RecoveryMethodRecord[]>;
  revokeRecoveryMethod(methodId: string, now?: () => Date): Promise<void>;

  createRecoverySession(
    input: CreateRecoverySessionInput,
    now?: () => Date,
  ): Promise<RecoverySessionRecord>;
  getRecoverySession(sessionId: string): Promise<RecoverySessionRecord | null>;
  submitRecoveryEnvelope(sessionId: string, envelope: unknown): Promise<void>;
  /** One-time: returns the envelope once, then marks the session consumed. */
  consumeRecoverySession(
    sessionId: string,
    now?: () => Date,
  ): Promise<{ session: RecoverySessionRecord; envelope: unknown }>;
}

// --- In-memory implementation (shared store → multi-user isolation testable) ---

type StoredPayload = { ownerUserId: string; bytes: Uint8Array };

/** Shared state so several per-user backend views can prove isolation. */
export class InMemoryRemoteMemoryStore {
  readonly profiles = new Map<string, MemoryProfile>();
  readonly generations = new Map<string, MemoryGenerationMeta[]>();
  readonly payloads = new Map<string, StoredPayload>();
  readonly methods = new Map<string, RecoveryMethodRecord[]>();
  readonly sessions = new Map<string, RecoverySessionRecord>();

  /** Test-only: does a payload still exist at a locator? */
  hasPayload(locator: string): boolean {
    return this.payloads.has(locator);
  }

  /** Test-only: corrupt a payload's bytes. */
  corruptPayload(locator: string): void {
    const payload = this.payloads.get(locator);
    if (!payload) return;
    const bytes = Buffer.from(payload.bytes);
    const first = bytes[0];
    if (first !== undefined) bytes[0] = first ^ 0xff;
    this.payloads.set(locator, { ...payload, bytes });
  }
}

const locatorFor = (userId: string, backupId: string): string =>
  `mem/${userId}/${backupId}`;

const iso = (now?: () => Date): string =>
  (now ?? (() => new Date()))().toISOString();

class InMemoryRemoteMemoryBackend implements RemoteMemoryBackend {
  constructor(
    private readonly store: InMemoryRemoteMemoryStore,
    private readonly userId: string,
  ) {}

  private myGenerations(): MemoryGenerationMeta[] {
    return this.store.generations.get(this.userId) ?? [];
  }

  getProfile(): Promise<MemoryProfile | null> {
    return Promise.resolve(this.store.profiles.get(this.userId) ?? null);
  }

  ensureProfile(formatVersion: string): Promise<MemoryProfile> {
    const existing = this.store.profiles.get(this.userId);
    if (existing) return Promise.resolve(existing);
    const created: MemoryProfile = {
      userId: this.userId,
      privacyMode: 'standard',
      latestGeneration: null,
      formatVersion,
      createdAt: iso(),
      updatedAt: iso(),
    };
    this.store.profiles.set(this.userId, created);
    return Promise.resolve(created);
  }

  setPrivacyMode(mode: PrivacyMode): Promise<MemoryProfile> {
    const profile = this.store.profiles.get(this.userId) ?? {
      userId: this.userId,
      privacyMode: mode,
      latestGeneration: null,
      formatVersion: REMOTE_FORMAT_VERSION,
      createdAt: iso(),
      updatedAt: iso(),
    };
    const updated = { ...profile, privacyMode: mode, updatedAt: iso() };
    this.store.profiles.set(this.userId, updated);
    return Promise.resolve(updated);
  }

  listGenerations(): Promise<MemoryGenerationMeta[]> {
    return Promise.resolve(
      this.myGenerations()
        .filter((generation) => generation.state === 'committed')
        .sort((a, b) => b.generation - a.generation),
    );
  }

  async getLatest(): Promise<MemoryGenerationMeta | null> {
    const committed = await this.listGenerations();
    return committed[0] ?? null;
  }

  getGeneration(generation: number): Promise<MemoryGenerationMeta | null> {
    return Promise.resolve(
      this.myGenerations().find(
        (record) =>
          record.generation === generation && record.state === 'committed',
      ) ?? null,
    );
  }

  getGenerationById(backupId: string): Promise<MemoryGenerationMeta | null> {
    return Promise.resolve(
      this.myGenerations().find((record) => record.backupId === backupId) ??
        null,
    );
  }

  async createGeneration(
    input: CreateGenerationInput,
  ): Promise<MemoryGenerationMeta> {
    if (input.payload.byteLength > MAX_PAYLOAD_BYTES)
      throw new RemoteMemoryError(
        'too-large',
        'Payload exceeds the maximum size.',
      );
    const latest = await this.getLatest();
    const currentParent = latest?.generation ?? null;
    if (input.expectedParent !== currentParent)
      throw new RemoteMemoryError(
        'conflict',
        `Cloud latest generation is ${String(currentParent)}, not ${String(
          input.expectedParent,
        )}. Refresh and retry.`,
      );
    if (
      this.myGenerations().some((record) => record.backupId === input.backupId)
    )
      throw new RemoteMemoryError('conflict', 'Backup id already exists.');
    const generation = currentParent === null ? 0 : currentParent + 1;
    const backupId = input.backupId;
    const locator = locatorFor(this.userId, backupId);
    const payloadSha256 = `sha256:${createHash('sha256').update(input.payload).digest('hex')}`;
    this.store.payloads.set(locator, {
      ownerUserId: this.userId,
      bytes: Buffer.from(input.payload),
    });
    const meta: MemoryGenerationMeta = {
      backupId,
      userId: this.userId,
      generation,
      parentGeneration: currentParent,
      privacyMode: input.privacyMode,
      createdAt: iso(input.now),
      payloadSha256,
      payloadBytes: input.payload.byteLength,
      bundleFormatVersion: input.bundleFormatVersion,
      ...(input.cryptoVersion ? { cryptoVersion: input.cryptoVersion } : {}),
      ...(input.wrappedDek ? { wrappedDek: input.wrappedDek } : {}),
      state: 'committed',
      softDeletedAt: null,
    };
    const all = this.myGenerations();
    all.push(meta);
    this.store.generations.set(this.userId, all);
    const profile = await this.ensureProfile(input.bundleFormatVersion);
    this.store.profiles.set(this.userId, {
      ...profile,
      latestGeneration: generation,
      updatedAt: iso(input.now),
    });
    return meta;
  }

  getPayload(backupId: string): Promise<Uint8Array> {
    const locator = locatorFor(this.userId, backupId);
    const payload = this.store.payloads.get(locator);
    if (!payload || payload.ownerUserId !== this.userId)
      throw new RemoteMemoryError('not-found', 'Payload not found.');
    return Promise.resolve(payload.bytes);
  }

  retireGeneration(backupId: string, now?: () => Date): Promise<void> {
    const all = this.myGenerations();
    const record = all.find((generation) => generation.backupId === backupId);
    if (record) {
      record.state = 'retired';
      record.softDeletedAt = iso(now);
    }
    // Idempotent: always drop the payload, even if already retired (retry orphan cleanup).
    this.store.payloads.delete(locatorFor(this.userId, backupId));
    return Promise.resolve();
  }

  listAllBackupIds(): Promise<string[]> {
    return Promise.resolve(this.myGenerations().map((g) => g.backupId));
  }

  addRecoveryMethod(
    input: AddRecoveryMethodInput,
    now?: () => Date,
  ): Promise<RecoveryMethodRecord> {
    const record: RecoveryMethodRecord = {
      methodId: randomUUID(),
      userId: this.userId,
      type: input.type,
      label: input.label,
      publicIdentifier: input.publicIdentifier ?? null,
      mmkWrapper: input.mmkWrapper,
      cryptoVersion: input.cryptoVersion,
      createdAt: iso(now),
      revokedAt: null,
    };
    const all = this.store.methods.get(this.userId) ?? [];
    all.push(record);
    this.store.methods.set(this.userId, all);
    return Promise.resolve(record);
  }

  listRecoveryMethods(): Promise<RecoveryMethodRecord[]> {
    return Promise.resolve(
      (this.store.methods.get(this.userId) ?? []).filter(
        (method) => method.revokedAt === null,
      ),
    );
  }

  revokeRecoveryMethod(methodId: string, now?: () => Date): Promise<void> {
    const all = this.store.methods.get(this.userId) ?? [];
    const record = all.find((method) => method.methodId === methodId);
    if (record) record.revokedAt = iso(now);
    return Promise.resolve();
  }

  createRecoverySession(
    input: CreateRecoverySessionInput,
    now?: () => Date,
  ): Promise<RecoverySessionRecord> {
    const record: RecoverySessionRecord = {
      sessionId: input.sessionId,
      userId: this.userId,
      direction: input.direction,
      session: input.session,
      createdAt: iso(now),
      expiresAt: input.expiresAt,
      consumedAt: null,
      envelope: null,
    };
    this.store.sessions.set(input.sessionId, record);
    return Promise.resolve(record);
  }

  getRecoverySession(sessionId: string): Promise<RecoverySessionRecord | null> {
    const record = this.store.sessions.get(sessionId);
    if (!record || record.userId !== this.userId) return Promise.resolve(null);
    return Promise.resolve(record);
  }

  submitRecoveryEnvelope(sessionId: string, envelope: unknown): Promise<void> {
    const record = this.store.sessions.get(sessionId);
    if (!record || record.userId !== this.userId)
      throw new RemoteMemoryError('not-found', 'Recovery session not found.');
    record.envelope = envelope;
    return Promise.resolve();
  }

  consumeRecoverySession(
    sessionId: string,
    now?: () => Date,
  ): Promise<{ session: RecoverySessionRecord; envelope: unknown }> {
    const record = this.store.sessions.get(sessionId);
    if (!record || record.userId !== this.userId)
      throw new RemoteMemoryError('not-found', 'Recovery session not found.');
    if (record.consumedAt !== null)
      throw new RemoteMemoryError(
        'session-consumed',
        'Recovery session already used.',
      );
    if (
      (now ?? (() => new Date()))().getTime() >
      new Date(record.expiresAt).getTime()
    )
      throw new RemoteMemoryError(
        'session-expired',
        'Recovery session expired.',
      );
    if (record.envelope === null)
      throw new RemoteMemoryError('no-envelope', 'No envelope submitted yet.');
    record.consumedAt = iso(now);
    return Promise.resolve({ session: record, envelope: record.envelope });
  }
}

/** Build a per-user in-memory backend over a shared store. */
export const inMemoryRemoteMemoryBackend = (
  store: InMemoryRemoteMemoryStore,
  userId: string,
): RemoteMemoryBackend => new InMemoryRemoteMemoryBackend(store, userId);

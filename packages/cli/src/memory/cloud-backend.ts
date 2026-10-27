/**
 * StackCloudRemoteMemoryBackend — a `RemoteMemoryBackend` (from @stack/memory)
 * implemented over the HTTP cloud client. This completes the three-way symmetry of
 * the domain contract: in-memory (tests), Supabase (server), and HTTP (this CLI).
 * The domain `modes` functions (standard/protected backup, recover, migrate) run
 * unchanged over this backend.
 */
import {
  RemoteMemoryError,
  type AddRecoveryMethodInput,
  type CreateGenerationInput,
  type CreateRecoverySessionInput,
  type MemoryGenerationMeta,
  type MemoryProfile,
  type RecoveryMethodRecord,
  type RecoverySessionRecord,
  type RemoteMemoryBackend,
  type WrappedDek,
} from '@stack/memory';
import { StackCloudError, type CloudMemoryClient } from '@stack/cloud-client';
import type {
  MemoryGenerationDto,
  MemoryProfileDto,
  MemoryRecoveryMethodDto,
  MemoryRecoverySessionDto,
} from '@stack/spec';

/**
 * Task 13 fix round 2, Important-2: the real HTTP client surfaces a conflicting
 * `createGeneration` as a `StackCloudError` with `code: 'memory-conflict'` (the
 * server's actual error code — see `packages/cloud-server/src/errors.ts`), not
 * the domain's own `RemoteMemoryError('conflict', …)` shape. `pushCanonicalMemory`'s
 * retry loop (`@stack/memory`'s `canonical/push.ts`) only recognizes the latter
 * (`isConflictError` checks `code === 'conflict'`), so over real HTTP the retry
 * never fired at all — a 409 just propagated as an opaque failure. Normalized
 * HERE, at the adapter boundary, so the domain layer never has to know about
 * HTTP-specific error shapes.
 */
const normalizeConflict = (error: unknown): never => {
  if (error instanceof StackCloudError && error.code === 'memory-conflict')
    throw new RemoteMemoryError('conflict', error.message);
  throw error;
};

const toProfile = (dto: MemoryProfileDto): MemoryProfile => ({
  userId: dto.userId,
  privacyMode: dto.privacyMode,
  latestGeneration: dto.latestGeneration,
  formatVersion: dto.formatVersion,
  createdAt: dto.createdAt,
  updatedAt: dto.updatedAt,
});

const toGeneration = (dto: MemoryGenerationDto): MemoryGenerationMeta => ({
  backupId: dto.backupId,
  userId: dto.userId,
  generation: dto.generation,
  parentGeneration: dto.parentGeneration,
  privacyMode: dto.privacyMode,
  createdAt: dto.createdAt,
  payloadSha256: dto.payloadSha256,
  payloadBytes: dto.payloadBytes,
  bundleFormatVersion: dto.bundleFormatVersion,
  ...(dto.cryptoVersion ? { cryptoVersion: dto.cryptoVersion } : {}),
  ...(dto.wrappedDek ? { wrappedDek: dto.wrappedDek as WrappedDek } : {}),
  state: dto.state,
  softDeletedAt: dto.softDeletedAt ?? null,
  ...(dto.replicaOf ? { replicaOf: dto.replicaOf } : {}),
});

const toMethod = (dto: MemoryRecoveryMethodDto): RecoveryMethodRecord => ({
  methodId: dto.methodId,
  userId: dto.userId,
  type: dto.type,
  label: dto.label,
  publicIdentifier: dto.publicIdentifier,
  mmkWrapper: dto.mmkWrapper,
  cryptoVersion: dto.cryptoVersion,
  createdAt: dto.createdAt,
  revokedAt: dto.revokedAt,
});

const toSession = (dto: MemoryRecoverySessionDto): RecoverySessionRecord => ({
  sessionId: dto.sessionId,
  userId: dto.userId,
  direction: dto.direction,
  session: dto.session,
  createdAt: dto.createdAt,
  expiresAt: dto.expiresAt,
  consumedAt: dto.consumedAt,
  envelope: dto.envelope ?? null,
});

export const stackCloudRemoteMemoryBackend = (
  client: CloudMemoryClient,
): RemoteMemoryBackend => ({
  getProfile: async () => {
    const { profile } = await client.memoryGetProfile();
    return profile ? toProfile(profile) : null;
  },
  ensureProfile: async (formatVersion) =>
    toProfile((await client.memoryEnsureProfile(formatVersion)).profile),
  setPrivacyMode: async (mode) =>
    toProfile((await client.memorySetPrivacyMode(mode)).profile),
  listGenerations: async () =>
    (await client.memoryListGenerations()).generations.map(toGeneration),
  // The CLI backend only sees committed generations via the client; Delete Cloud Memory
  // (which needs retired ids too) runs server-side, not through this backend.
  listAllBackupIds: async () =>
    (await client.memoryListGenerations()).generations.map((g) => g.backupId),
  getLatest: async () => {
    const { generation } = await client.memoryGetLatest();
    return generation ? toGeneration(generation) : null;
  },
  getGeneration: async (generation) => {
    const result = await client.memoryGetGeneration(generation);
    return result.generation ? toGeneration(result.generation) : null;
  },
  getGenerationById: async (backupId) => {
    const result = await client.memoryGetGenerationById(backupId);
    return result.generation ? toGeneration(result.generation) : null;
  },
  createGeneration: async (input: CreateGenerationInput) => {
    const result = await client
      .memoryCreateGeneration({
        backupId: input.backupId,
        expectedParent: input.expectedParent,
        privacyMode: input.privacyMode,
        payloadB64: Buffer.from(input.payload).toString('base64'),
        bundleFormatVersion: input.bundleFormatVersion,
        ...(input.cryptoVersion ? { cryptoVersion: input.cryptoVersion } : {}),
        ...(input.wrappedDek ? { wrappedDek: input.wrappedDek } : {}),
        ...(input.replicaOf !== undefined
          ? { replicaOf: input.replicaOf }
          : {}),
      })
      .catch(normalizeConflict);
    return toGeneration(result.generation);
  },
  getPayload: async (backupId) => {
    const { payloadB64 } = await client.memoryGetPayload(backupId);
    return Buffer.from(payloadB64, 'base64');
  },
  retireGeneration: async (backupId) => {
    await client.memoryRetireGeneration(backupId);
  },
  addRecoveryMethod: async (input: AddRecoveryMethodInput) => {
    const { method } = await client.memoryAddRecoveryMethod({
      type: input.type,
      label: input.label,
      publicIdentifier: input.publicIdentifier ?? null,
      mmkWrapper: input.mmkWrapper,
      cryptoVersion: input.cryptoVersion,
    });
    return toMethod(method);
  },
  listRecoveryMethods: async () =>
    (await client.memoryListRecoveryMethods()).methods.map(toMethod),
  revokeRecoveryMethod: async (methodId) => {
    await client.memoryRevokeRecoveryMethod(methodId);
  },
  createRecoverySession: async (input: CreateRecoverySessionInput) => {
    const { session } = await client.memoryCreateSession({
      sessionId: input.sessionId,
      direction: input.direction,
      session: input.session,
      expiresAt: input.expiresAt,
    });
    return toSession(session);
  },
  getRecoverySession: async (sessionId) => {
    const { session } = await client.memoryGetSession(sessionId);
    return session ? toSession(session) : null;
  },
  submitRecoveryEnvelope: async (sessionId, envelope) => {
    await client.memorySubmitEnvelope(sessionId, envelope);
  },
  consumeRecoverySession: async (sessionId) => {
    const result = await client.memoryConsumeSession(sessionId);
    return { session: toSession(result.session), envelope: result.envelope };
  },
});

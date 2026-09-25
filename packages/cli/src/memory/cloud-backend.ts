/**
 * StackCloudRemoteMemoryBackend — a `RemoteMemoryBackend` (from @stack/memory)
 * implemented over the HTTP cloud client. This completes the three-way symmetry of
 * the domain contract: in-memory (tests), Supabase (server), and HTTP (this CLI).
 * The domain `modes` functions (standard/protected backup, recover, migrate) run
 * unchanged over this backend.
 */
import type {
  AddRecoveryMethodInput,
  CreateGenerationInput,
  CreateRecoverySessionInput,
  MemoryGenerationMeta,
  MemoryProfile,
  RecoveryMethodRecord,
  RecoverySessionRecord,
  RemoteMemoryBackend,
  WrappedDek,
} from '@stack/memory';
import type { CloudMemoryClient } from '@stack/cloud-client';
import type {
  MemoryGenerationDto,
  MemoryProfileDto,
  MemoryRecoveryMethodDto,
  MemoryRecoverySessionDto,
} from '@stack/spec';

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
    const result = await client.memoryCreateGeneration({
      backupId: input.backupId,
      expectedParent: input.expectedParent,
      privacyMode: input.privacyMode,
      payloadB64: Buffer.from(input.payload).toString('base64'),
      bundleFormatVersion: input.bundleFormatVersion,
      ...(input.cryptoVersion ? { cryptoVersion: input.cryptoVersion } : {}),
      ...(input.wrappedDek ? { wrappedDek: input.wrappedDek } : {}),
    });
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

/**
 * Remote Memory service methods (Phase 14B). RPC over the `RemoteMemoryBackend`
 * domain contract: each method authenticates (the caller passes the derived user),
 * resolves a per-user backend via the injected factory, and maps domain
 * `RemoteMemoryError`s to HTTP `CloudServiceError`s. The server never interprets
 * opaque wrapper/session/envelope JSON and never sees plaintext for Protected
 * backups (payloads are ciphertext).
 */
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_V2,
  RemoteMemoryError,
  type MemoryGenerationMeta,
  type MemoryProfile,
  type RecoveryMethodRecord,
  type RecoverySessionRecord,
  type RemoteMemoryBackend,
  type WrappedDek,
} from '@stack/memory';
import type {
  MemoryAddRecoveryMethodRequest,
  MemoryCreateGenerationRequest,
  MemoryCreateSessionRequest,
  MemoryGenerationDto,
  MemoryProfileDto,
  MemoryRecoveryMethodDto,
  MemoryRecoverySessionDto,
} from '@stack/spec';

import {
  CloudServiceError,
  memoryConflict,
  memoryIncompatibleFormat,
  memoryIntegrity,
  memoryNoEnvelope,
  memoryNotConfigured,
  memoryNotFound,
  memoryNotProtected,
  memorySessionConsumed,
  memorySessionExpired,
  memoryTooLarge,
} from './errors.js';

export type MemoryAuthenticatedUser = { userId: string };

export type MemoryServiceConfig = {
  memoryBackendFor?: (userId: string) => RemoteMemoryBackend;
  now?: () => Date;
};

export type MemoryService = ReturnType<typeof createMemoryMethods>;

const mapError = (error: unknown): never => {
  if (error instanceof RemoteMemoryError) {
    switch (error.code) {
      case 'conflict':
        throw memoryConflict(error.message);
      case 'not-found':
        throw memoryNotFound(error.message);
      case 'too-large':
        throw memoryTooLarge(error.message);
      case 'integrity':
        throw memoryIntegrity(error.message);
      case 'not-protected':
      case 'mmk-required':
        throw memoryNotProtected(error.message);
      case 'session-consumed':
        throw memorySessionConsumed(error.message);
      case 'session-expired':
        throw memorySessionExpired(error.message);
      case 'no-envelope':
        throw memoryNoEnvelope(error.message);
      case 'incompatible-format':
        throw memoryIncompatibleFormat(error.message);
      default:
        throw error;
    }
  }
  throw error;
};

const profileDto = (profile: MemoryProfile): MemoryProfileDto => ({
  userId: profile.userId,
  privacyMode: profile.privacyMode,
  latestGeneration: profile.latestGeneration,
  formatVersion: profile.formatVersion,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const generationDto = (meta: MemoryGenerationMeta): MemoryGenerationDto => ({
  backupId: meta.backupId,
  userId: meta.userId,
  generation: meta.generation,
  parentGeneration: meta.parentGeneration,
  privacyMode: meta.privacyMode,
  createdAt: meta.createdAt,
  payloadSha256: meta.payloadSha256,
  payloadBytes: meta.payloadBytes,
  bundleFormatVersion: meta.bundleFormatVersion,
  ...(meta.cryptoVersion ? { cryptoVersion: meta.cryptoVersion } : {}),
  ...(meta.wrappedDek ? { wrappedDek: meta.wrappedDek } : {}),
  state: meta.state,
  softDeletedAt: meta.softDeletedAt ?? null,
});

const methodDto = (record: RecoveryMethodRecord): MemoryRecoveryMethodDto => ({
  methodId: record.methodId,
  userId: record.userId,
  type: record.type,
  label: record.label,
  publicIdentifier: record.publicIdentifier,
  mmkWrapper: record.mmkWrapper,
  cryptoVersion: record.cryptoVersion,
  createdAt: record.createdAt,
  revokedAt: record.revokedAt,
});

const sessionDto = (
  record: RecoverySessionRecord,
): MemoryRecoverySessionDto => ({
  sessionId: record.sessionId,
  userId: record.userId,
  direction: record.direction,
  session: record.session,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  consumedAt: record.consumedAt,
  envelope: record.envelope,
});

export const createMemoryMethods = (config: MemoryServiceConfig) => {
  const now = () => (config.now ?? (() => new Date()))();
  const backendFor = (userId: string): RemoteMemoryBackend => {
    if (!config.memoryBackendFor) throw memoryNotConfigured();
    return config.memoryBackendFor(userId);
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CloudServiceError) throw error;
      return mapError(error);
    }
  };

  return {
    memoryGetProfile: (user: MemoryAuthenticatedUser) =>
      run(async () => {
        const profile = await backendFor(user.userId).getProfile();
        return { profile: profile ? profileDto(profile) : null };
      }),

    memoryEnsureProfile: (
      user: MemoryAuthenticatedUser,
      formatVersion: string,
    ) =>
      run(async () => ({
        profile: profileDto(
          await backendFor(user.userId).ensureProfile(formatVersion),
        ),
      })),

    memorySetPrivacyMode: (
      user: MemoryAuthenticatedUser,
      mode: 'standard' | 'protected',
    ) =>
      run(async () => ({
        profile: profileDto(await backendFor(user.userId).setPrivacyMode(mode)),
      })),

    memoryListGenerations: (user: MemoryAuthenticatedUser) =>
      run(async () => ({
        generations: (await backendFor(user.userId).listGenerations()).map(
          generationDto,
        ),
      })),

    memoryGetLatest: (user: MemoryAuthenticatedUser) =>
      run(async () => {
        const meta = await backendFor(user.userId).getLatest();
        return { generation: meta ? generationDto(meta) : null };
      }),

    memoryGetGeneration: (user: MemoryAuthenticatedUser, generation: number) =>
      run(async () => {
        const meta = await backendFor(user.userId).getGeneration(generation);
        return { generation: meta ? generationDto(meta) : null };
      }),

    memoryGetGenerationById: (
      user: MemoryAuthenticatedUser,
      backupId: string,
    ) =>
      run(async () => {
        const meta = await backendFor(user.userId).getGenerationById(backupId);
        return { generation: meta ? generationDto(meta) : null };
      }),

    memoryCreateGeneration: (
      user: MemoryAuthenticatedUser,
      request: MemoryCreateGenerationRequest,
    ) =>
      run(async () => {
        // Spec §9.3/A.5: once an account's latest generation is v2, the server
        // refuses an old-format (v1) create outright, with the exact `@beta`
        // message — regardless of which storage backend is configured. Enforced
        // HERE (backend-agnostic middle layer), not duplicated per backend,
        // because production's real backend (Supabase, via `memoryBackendFor`)
        // has no such check of its own; only the in-memory test fake did.
        const backend = backendFor(user.userId);
        const latest = await backend.getLatest();
        if (
          latest &&
          latest.bundleFormatVersion === BUNDLE_FORMAT_V2 &&
          request.bundleFormatVersion === BUNDLE_FORMAT
        )
          throw memoryIncompatibleFormat();
        const payload = Buffer.from(request.payloadB64, 'base64');
        const meta = await backend.createGeneration({
          backupId: request.backupId,
          expectedParent: request.expectedParent,
          privacyMode: request.privacyMode,
          payload,
          bundleFormatVersion: request.bundleFormatVersion,
          ...(request.cryptoVersion
            ? { cryptoVersion: request.cryptoVersion }
            : {}),
          ...(request.wrappedDek
            ? { wrappedDek: request.wrappedDek as WrappedDek }
            : {}),
          now,
        });
        return { generation: generationDto(meta) };
      }),

    memoryGetPayload: (user: MemoryAuthenticatedUser, backupId: string) =>
      run(async () => {
        const bytes = await backendFor(user.userId).getPayload(backupId);
        return { payloadB64: Buffer.from(bytes).toString('base64') };
      }),

    memoryRetireGeneration: (user: MemoryAuthenticatedUser, backupId: string) =>
      run(async () => {
        await backendFor(user.userId).retireGeneration(backupId, now);
        return { ok: true as const };
      }),

    memoryAddRecoveryMethod: (
      user: MemoryAuthenticatedUser,
      request: MemoryAddRecoveryMethodRequest,
    ) =>
      run(async () => {
        const record = await backendFor(user.userId).addRecoveryMethod(
          {
            type: request.type,
            label: request.label,
            publicIdentifier: request.publicIdentifier ?? null,
            mmkWrapper: request.mmkWrapper,
            cryptoVersion: request.cryptoVersion,
          },
          now,
        );
        return { method: methodDto(record) };
      }),

    memoryListRecoveryMethods: (user: MemoryAuthenticatedUser) =>
      run(async () => ({
        methods: (await backendFor(user.userId).listRecoveryMethods()).map(
          methodDto,
        ),
      })),

    memoryRevokeRecoveryMethod: (
      user: MemoryAuthenticatedUser,
      methodId: string,
    ) =>
      run(async () => {
        await backendFor(user.userId).revokeRecoveryMethod(methodId, now);
        return { ok: true as const };
      }),

    memoryCreateSession: (
      user: MemoryAuthenticatedUser,
      request: MemoryCreateSessionRequest,
    ) =>
      run(async () => {
        const record = await backendFor(user.userId).createRecoverySession(
          {
            sessionId: request.sessionId,
            direction: request.direction,
            session: request.session,
            expiresAt: request.expiresAt,
          },
          now,
        );
        return { session: sessionDto(record) };
      }),

    memoryGetSession: (user: MemoryAuthenticatedUser, sessionId: string) =>
      run(async () => {
        const record = await backendFor(user.userId).getRecoverySession(
          sessionId,
        );
        return { session: record ? sessionDto(record) : null };
      }),

    memorySubmitEnvelope: (
      user: MemoryAuthenticatedUser,
      sessionId: string,
      envelope: unknown,
    ) =>
      run(async () => {
        await backendFor(user.userId).submitRecoveryEnvelope(
          sessionId,
          envelope,
        );
        return { ok: true as const };
      }),

    memoryConsumeSession: (user: MemoryAuthenticatedUser, sessionId: string) =>
      run(async () => {
        const result = await backendFor(user.userId).consumeRecoverySession(
          sessionId,
          now,
        );
        return {
          session: sessionDto(result.session),
          envelope: result.envelope,
        };
      }),
  };
};

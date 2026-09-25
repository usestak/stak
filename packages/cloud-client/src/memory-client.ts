/**
 * Remote Memory client methods (Phase 14B) — RPC over the RemoteMemoryBackend
 * contract. Responses are validated against @stack/spec schemas. Composed into the
 * main cloud client (see client.ts).
 */
import {
  memoryConsumeSessionResponseSchema,
  memoryGenerationResponseSchema,
  memoryGenerationsResponseSchema,
  memoryGenerationValueResponseSchema,
  memoryOkResponseSchema,
  memoryPayloadResponseSchema,
  memoryProfileResponseSchema,
  memoryProfileValueResponseSchema,
  memoryRecoveryMethodResponseSchema,
  memoryRecoveryMethodsResponseSchema,
  memoryRecoverySessionResponseSchema,
  memoryRecoverySessionValueResponseSchema,
  type MemoryAddRecoveryMethodRequest,
  type MemoryCreateGenerationRequest,
  type MemoryCreateSessionRequest,
  type MemoryGenerationDto,
  type MemoryPrivacyMode,
  type MemoryProfileDto,
  type MemoryRecoveryMethodDto,
  type MemoryRecoverySessionDto,
} from '@stack/spec';

type RequestFn = (
  method: string,
  apiPath: string,
  init: { auth: boolean; json?: unknown; bytes?: Uint8Array; raw?: boolean },
) => Promise<{
  status: number;
  contentType: string;
  text: string;
  bytes: Uint8Array;
}>;

type JsonFn = <T>(
  schema: { parse(value: unknown): T },
  payload: { contentType: string; text: string },
) => T;

export interface CloudMemoryClient {
  memoryGetProfile(): Promise<{ profile: MemoryProfileDto | null }>;
  memoryEnsureProfile(
    formatVersion: string,
  ): Promise<{ profile: MemoryProfileDto }>;
  memorySetPrivacyMode(
    privacyMode: MemoryPrivacyMode,
  ): Promise<{ profile: MemoryProfileDto }>;
  memoryListGenerations(): Promise<{ generations: MemoryGenerationDto[] }>;
  memoryGetLatest(): Promise<{ generation: MemoryGenerationDto | null }>;
  memoryGetGeneration(
    generation: number,
  ): Promise<{ generation: MemoryGenerationDto | null }>;
  memoryGetGenerationById(
    backupId: string,
  ): Promise<{ generation: MemoryGenerationDto | null }>;
  memoryCreateGeneration(
    request: MemoryCreateGenerationRequest,
  ): Promise<{ generation: MemoryGenerationDto }>;
  memoryGetPayload(backupId: string): Promise<{ payloadB64: string }>;
  memoryRetireGeneration(backupId: string): Promise<{ ok: true }>;
  memoryAddRecoveryMethod(
    request: MemoryAddRecoveryMethodRequest,
  ): Promise<{ method: MemoryRecoveryMethodDto }>;
  memoryListRecoveryMethods(): Promise<{ methods: MemoryRecoveryMethodDto[] }>;
  memoryRevokeRecoveryMethod(methodId: string): Promise<{ ok: true }>;
  memoryCreateSession(
    request: MemoryCreateSessionRequest,
  ): Promise<{ session: MemoryRecoverySessionDto }>;
  memoryGetSession(
    sessionId: string,
  ): Promise<{ session: MemoryRecoverySessionDto | null }>;
  memorySubmitEnvelope(
    sessionId: string,
    envelope: unknown,
  ): Promise<{ ok: true }>;
  memoryConsumeSession(
    sessionId: string,
  ): Promise<{ session: MemoryRecoverySessionDto; envelope: unknown }>;
}

const enc = (value: string): string => encodeURIComponent(value);

export const createMemoryClientMethods = (deps: {
  request: RequestFn;
  json: JsonFn;
}): CloudMemoryClient => {
  const { request, json } = deps;
  return {
    memoryGetProfile: async () =>
      json(
        memoryProfileResponseSchema,
        await request('GET', 'memory/profile', { auth: true }),
      ),
    memoryEnsureProfile: async (formatVersion) =>
      json(
        memoryProfileValueResponseSchema,
        await request('POST', 'memory/profile-ensure', {
          auth: true,
          json: { formatVersion },
        }),
      ),
    memorySetPrivacyMode: async (privacyMode) =>
      json(
        memoryProfileValueResponseSchema,
        await request('POST', 'memory/privacy', {
          auth: true,
          json: { privacyMode },
        }),
      ),
    memoryListGenerations: async () =>
      json(
        memoryGenerationsResponseSchema,
        await request('GET', 'memory/generations', { auth: true }),
      ),
    memoryGetLatest: async () =>
      json(
        memoryGenerationResponseSchema,
        await request('GET', 'memory/latest', { auth: true }),
      ),
    memoryGetGeneration: async (generation) =>
      json(
        memoryGenerationResponseSchema,
        await request('GET', `memory/by-number/${generation}`, { auth: true }),
      ),
    memoryGetGenerationById: async (backupId) =>
      json(
        memoryGenerationResponseSchema,
        await request('GET', `memory/generations/${enc(backupId)}`, {
          auth: true,
        }),
      ),
    memoryCreateGeneration: async (body) =>
      json(
        memoryGenerationValueResponseSchema,
        await request('POST', 'memory/generations', { auth: true, json: body }),
      ),
    memoryGetPayload: async (backupId) =>
      json(
        memoryPayloadResponseSchema,
        await request('GET', `memory/generations/${enc(backupId)}/payload`, {
          auth: true,
        }),
      ),
    memoryRetireGeneration: async (backupId) =>
      json(
        memoryOkResponseSchema,
        await request('POST', `memory/generations/${enc(backupId)}/retire`, {
          auth: true,
          json: {},
        }),
      ),
    memoryAddRecoveryMethod: async (body) =>
      json(
        memoryRecoveryMethodResponseSchema,
        await request('POST', 'memory/recovery-methods', {
          auth: true,
          json: body,
        }),
      ),
    memoryListRecoveryMethods: async () =>
      json(
        memoryRecoveryMethodsResponseSchema,
        await request('GET', 'memory/recovery-methods', { auth: true }),
      ),
    memoryRevokeRecoveryMethod: async (methodId) =>
      json(
        memoryOkResponseSchema,
        await request(
          'POST',
          `memory/recovery-methods/${enc(methodId)}/revoke`,
          { auth: true, json: {} },
        ),
      ),
    memoryCreateSession: async (body) =>
      json(
        memoryRecoverySessionValueResponseSchema,
        await request('POST', 'memory/sessions', { auth: true, json: body }),
      ),
    memoryGetSession: async (sessionId) =>
      json(
        memoryRecoverySessionResponseSchema,
        await request('GET', `memory/sessions/${enc(sessionId)}`, {
          auth: true,
        }),
      ),
    memorySubmitEnvelope: async (sessionId, envelope) =>
      json(
        memoryOkResponseSchema,
        await request('POST', `memory/sessions/${enc(sessionId)}/envelope`, {
          auth: true,
          json: { envelope },
        }),
      ),
    memoryConsumeSession: async (sessionId) =>
      json(
        memoryConsumeSessionResponseSchema,
        await request('POST', `memory/sessions/${enc(sessionId)}/consume`, {
          auth: true,
          json: {},
        }),
      ),
  };
};

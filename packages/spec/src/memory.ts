import { z } from 'zod';

/**
 * Wire DTOs for remote Stack Memory (Phase 14B). The API is RPC over the
 * `RemoteMemoryBackend` domain contract; each method has a request/response schema
 * validated on both sides. Opaque fields (`mmkWrapper`, `session`, `envelope`) are
 * `unknown` — the server relays them without interpretation. Protected metadata
 * carries no project/file identities (those live inside the encrypted bundle).
 */

/** Max base64 payload accepted on the wire (~9 MiB decoded). Memory is small. */
export const MEMORY_MAX_PAYLOAD_B64 = 12 * 1024 * 1024;

export const memoryPrivacyModeSchema = z.enum(['standard', 'protected']);
export type MemoryPrivacyMode = z.infer<typeof memoryPrivacyModeSchema>;

export const memoryGenerationStateSchema = z.enum([
  'pending',
  'committed',
  'retired',
]);

export const memoryWrappedDekSchema = z.object({
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});

export const memoryProfileSchema = z.object({
  userId: z.string().min(1),
  privacyMode: memoryPrivacyModeSchema,
  latestGeneration: z.number().int().nonnegative().nullable(),
  formatVersion: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoryProfileDto = z.infer<typeof memoryProfileSchema>;

export const memoryGenerationSchema = z.object({
  backupId: z.string().min(1),
  userId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  parentGeneration: z.number().int().nonnegative().nullable(),
  privacyMode: memoryPrivacyModeSchema,
  createdAt: z.iso.datetime({ offset: true }),
  payloadSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payloadBytes: z.number().int().nonnegative(),
  bundleFormatVersion: z.string().min(1),
  cryptoVersion: z.string().min(1).optional(),
  wrappedDek: memoryWrappedDekSchema.optional(),
  state: memoryGenerationStateSchema,
  softDeletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Task 13 fix round 3: on a Protected replica made by `stak memory
   * protect`, the backupId of the Standard original it re-encrypts. */
  replicaOf: z.string().min(1).nullable().optional(),
});
export type MemoryGenerationDto = z.infer<typeof memoryGenerationSchema>;

export const memoryRecoveryMethodSchema = z.object({
  methodId: z.string().min(1),
  userId: z.string().min(1),
  type: z.enum(['passkey', 'recovery-file', 'trusted-device']),
  label: z.string().min(1),
  publicIdentifier: z.string().nullable(),
  mmkWrapper: z.unknown(),
  cryptoVersion: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type MemoryRecoveryMethodDto = z.infer<
  typeof memoryRecoveryMethodSchema
>;

export const memoryRecoverySessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  direction: z.enum(['recovery', 'enrollment']),
  session: z.unknown(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  consumedAt: z.iso.datetime({ offset: true }).nullable(),
  envelope: z.unknown().nullable(),
});
export type MemoryRecoverySessionDto = z.infer<
  typeof memoryRecoverySessionSchema
>;

/* ---------------------------- requests ------------------------------------ */

export const memoryEnsureProfileRequestSchema = z.object({
  formatVersion: z.string().min(1),
});
export const memorySetPrivacyModeRequestSchema = z.object({
  privacyMode: memoryPrivacyModeSchema,
});
export const memoryCreateGenerationRequestSchema = z.object({
  backupId: z.string().min(1),
  expectedParent: z.number().int().nonnegative().nullable(),
  privacyMode: memoryPrivacyModeSchema,
  payloadB64: z.string().max(MEMORY_MAX_PAYLOAD_B64),
  bundleFormatVersion: z.string().min(1),
  cryptoVersion: z.string().min(1).optional(),
  wrappedDek: memoryWrappedDekSchema.optional(),
  /**
   * Task 13 fix round 3: set ONLY by `stak memory protect`'s migration — the
   * backupId of the committed Standard generation this create replicates. The
   * server verifies it against its own records (same account, committed,
   * Standard, same format, no existing replica, payload length = original +
   * 28, account still Standard, create Protected) before it exempts the create
   * from the sticky v1-after-v2 gate; an invalid claim is refused outright.
   */
  replicaOf: z.string().min(1).optional(),
});
export const memoryAddRecoveryMethodRequestSchema = z.object({
  type: z.enum(['passkey', 'recovery-file', 'trusted-device']),
  label: z.string().min(1),
  publicIdentifier: z.string().nullable().optional(),
  mmkWrapper: z.unknown(),
  cryptoVersion: z.string().min(1),
});
export const memoryCreateSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  direction: z.enum(['recovery', 'enrollment']),
  session: z.unknown(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const memorySubmitEnvelopeRequestSchema = z.object({
  envelope: z.unknown(),
});

/* ---------------------------- responses ----------------------------------- */

export const memoryProfileResponseSchema = z.object({
  profile: memoryProfileSchema.nullable(),
});
export const memoryProfileValueResponseSchema = z.object({
  profile: memoryProfileSchema,
});
export const memoryGenerationsResponseSchema = z.object({
  generations: z.array(memoryGenerationSchema),
});
export const memoryGenerationResponseSchema = z.object({
  generation: memoryGenerationSchema.nullable(),
});
export const memoryGenerationValueResponseSchema = z.object({
  generation: memoryGenerationSchema,
});
export const memoryPayloadResponseSchema = z.object({
  payloadB64: z.string().max(MEMORY_MAX_PAYLOAD_B64),
});
export const memoryRecoveryMethodsResponseSchema = z.object({
  methods: z.array(memoryRecoveryMethodSchema),
});
export const memoryRecoveryMethodResponseSchema = z.object({
  method: memoryRecoveryMethodSchema,
});
export const memoryRecoverySessionResponseSchema = z.object({
  session: memoryRecoverySessionSchema.nullable(),
});
export const memoryRecoverySessionValueResponseSchema = z.object({
  session: memoryRecoverySessionSchema,
});
export const memoryConsumeSessionResponseSchema = z.object({
  session: memoryRecoverySessionSchema,
  envelope: z.unknown(),
});
export const memoryOkResponseSchema = z.object({ ok: z.literal(true) });

export type MemoryCreateGenerationRequest = z.infer<
  typeof memoryCreateGenerationRequestSchema
>;
export type MemoryAddRecoveryMethodRequest = z.infer<
  typeof memoryAddRecoveryMethodRequestSchema
>;
export type MemoryCreateSessionRequest = z.infer<
  typeof memoryCreateSessionRequestSchema
>;

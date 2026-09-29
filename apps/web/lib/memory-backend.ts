import { createHash, randomUUID } from 'node:crypto';

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
} from '@stack/memory';

import { serviceClient } from './supabase';

const MEMORY_BUCKET = 'stack-memory';
const REMOTE_FORMAT_VERSION = 'stack-mem-remote-v1';

const locatorFor = (userId: string, backupId: string) =>
  `mem/${userId}/${backupId}`;
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const mapProfile = (row: any): MemoryProfile => ({
  userId: row.user_id,
  privacyMode: row.privacy_mode,
  latestGeneration: row.latest_generation ?? null,
  formatVersion: row.format_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapGeneration = (row: any): MemoryGenerationMeta => ({
  backupId: row.backup_id,
  userId: row.user_id,
  generation: row.generation,
  parentGeneration: row.parent_generation ?? null,
  privacyMode: row.privacy_mode,
  createdAt: row.created_at,
  payloadSha256: row.payload_sha256,
  payloadBytes: Number(row.payload_bytes),
  bundleFormatVersion: row.bundle_format_version,
  ...(row.crypto_version ? { cryptoVersion: row.crypto_version } : {}),
  ...(row.wrapped_dek ? { wrappedDek: row.wrapped_dek } : {}),
  state: row.state,
  softDeletedAt: row.soft_deleted_at ?? null,
});

const mapMethod = (row: any): RecoveryMethodRecord => ({
  methodId: row.method_id,
  userId: row.user_id,
  type: row.type,
  label: row.label,
  publicIdentifier: row.public_identifier ?? null,
  mmkWrapper: row.mmk_wrapper,
  cryptoVersion: row.crypto_version,
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? null,
});

const mapSession = (row: any): RecoverySessionRecord => ({
  sessionId: row.session_id,
  userId: row.user_id,
  direction: row.direction,
  session: row.session,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at ?? null,
  envelope: row.envelope ?? null,
});

/**
 * Supabase-backed per-user RemoteMemoryBackend. Identity is bound at construction
 * from the authenticated token (never a request field). Uses the service-role
 * client after identity is derived; RLS is defense-in-depth. Payloads live in the
 * private `stack-memory` bucket; generations commit atomically via the
 * commit_memory_generation RPC (optimistic concurrency).
 */
export const supabaseRemoteMemoryBackend = (
  userId: string,
): RemoteMemoryBackend => {
  const db = () => serviceClient();
  const storage = () => serviceClient().storage.from(MEMORY_BUCKET);

  const readProfile = async (): Promise<MemoryProfile | null> => {
    const { data, error } = await db()
      .from('memory_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Memory profile read failed: ${error.message}`);
    return data ? mapProfile(data) : null;
  };

  return {
    getProfile: readProfile,

    ensureProfile: async (formatVersion: string) => {
      const existing = await readProfile();
      if (existing) return existing;
      const nowIso = new Date().toISOString();
      const { data, error } = await db()
        .from('memory_profiles')
        .upsert(
          {
            user_id: userId,
            privacy_mode: 'standard',
            latest_generation: null,
            format_version: formatVersion,
            created_at: nowIso,
            updated_at: nowIso,
          },
          { onConflict: 'user_id' },
        )
        .select('*')
        .single();
      if (error)
        throw new Error(`Memory profile create failed: ${error.message}`);
      return mapProfile(data);
    },

    setPrivacyMode: async (mode) => {
      const nowIso = new Date().toISOString();
      const { data, error } = await db()
        .from('memory_profiles')
        .upsert(
          {
            user_id: userId,
            privacy_mode: mode,
            format_version: REMOTE_FORMAT_VERSION,
            updated_at: nowIso,
          },
          { onConflict: 'user_id' },
        )
        .select('*')
        .single();
      if (error)
        throw new Error(`Memory privacy update failed: ${error.message}`);
      return mapProfile(data);
    },

    listGenerations: async () => {
      const { data, error } = await db()
        .from('memory_backups')
        .select('*')
        .eq('user_id', userId)
        .eq('state', 'committed')
        .order('generation', { ascending: false });
      if (error) throw new Error(`Memory list failed: ${error.message}`);
      return (data ?? []).map(mapGeneration);
    },

    getLatest: async () => {
      const { data, error } = await db()
        .from('memory_backups')
        .select('*')
        .eq('user_id', userId)
        .eq('state', 'committed')
        .order('generation', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Memory latest read failed: ${error.message}`);
      return data ? mapGeneration(data) : null;
    },

    getGeneration: async (generation) => {
      const { data, error } = await db()
        .from('memory_backups')
        .select('*')
        .eq('user_id', userId)
        .eq('generation', generation)
        .eq('state', 'committed')
        .maybeSingle();
      if (error)
        throw new Error(`Memory generation read failed: ${error.message}`);
      return data ? mapGeneration(data) : null;
    },

    getGenerationById: async (backupId) => {
      const { data, error } = await db()
        .from('memory_backups')
        .select('*')
        .eq('user_id', userId)
        .eq('backup_id', backupId)
        .maybeSingle();
      if (error)
        throw new Error(`Memory generation read failed: ${error.message}`);
      return data ? mapGeneration(data) : null;
    },

    createGeneration: async (input: CreateGenerationInput) => {
      // Each generation's payload object key is unique (per random backupId), and a
      // committed generation's object must never be overwritten. Upload WITHOUT
      // upsert (fail closed) so a committed generation's bytes are immutable — an
      // accidental re-upload of the same backupId errors instead of silently
      // replacing a committed payload. Matches the domain backend, which rejects a
      // duplicate backupId. (Phase 15B.5 immutability hardening.)
      const locator = locatorFor(userId, input.backupId);
      const { error: uploadError } = await storage().upload(
        locator,
        Buffer.from(input.payload),
        { contentType: 'application/octet-stream', upsert: false },
      );
      if (uploadError)
        throw new Error(`Memory payload upload failed: ${uploadError.message}`);
      const nowIso = (input.now ?? (() => new Date()))().toISOString();
      const { data, error } = await db().rpc('commit_memory_generation', {
        p_user_id: userId,
        p_backup_id: input.backupId,
        p_expected_parent: input.expectedParent,
        p_privacy_mode: input.privacyMode,
        p_payload_locator: locator,
        p_payload_sha256: sha256(input.payload),
        p_payload_bytes: input.payload.byteLength,
        p_bundle_format_version: input.bundleFormatVersion,
        p_crypto_version: input.cryptoVersion ?? null,
        p_wrapped_dek: input.wrappedDek ?? null,
        p_now: nowIso,
      });
      if (error) {
        if (error.message.includes('STACK_REMOTE_CONFLICT'))
          throw new RemoteMemoryError(
            'conflict',
            'Cloud latest generation moved. Refresh and retry.',
          );
        throw new Error(`Memory commit failed: ${error.message}`);
      }
      return mapGeneration((data as any).backup);
    },

    getPayload: async (backupId) => {
      const { data, error } = await storage().download(
        locatorFor(userId, backupId),
      );
      if (error || !data)
        throw new RemoteMemoryError('not-found', 'Memory payload not found.');
      return new Uint8Array(await data.arrayBuffer());
    },

    retireGeneration: async (backupId, now) => {
      const nowIso = (now ?? (() => new Date()))().toISOString();
      const { error } = await db()
        .from('memory_backups')
        .update({ state: 'retired', soft_deleted_at: nowIso })
        .eq('user_id', userId)
        .eq('backup_id', backupId);
      if (error) throw new Error(`Memory retire failed: ${error.message}`);
      await storage().remove([locatorFor(userId, backupId)]);
    },

    addRecoveryMethod: async (input: AddRecoveryMethodInput, now) => {
      const nowIso = (now ?? (() => new Date()))().toISOString();
      const record = {
        method_id: randomUUID(),
        user_id: userId,
        type: input.type,
        label: input.label,
        public_identifier: input.publicIdentifier ?? null,
        mmk_wrapper: input.mmkWrapper,
        crypto_version: input.cryptoVersion,
        created_at: nowIso,
        revoked_at: null,
      };
      const { data, error } = await db()
        .from('memory_recovery_methods')
        .insert(record)
        .select('*')
        .single();
      if (error)
        throw new Error(`Recovery method add failed: ${error.message}`);
      return mapMethod(data);
    },

    listRecoveryMethods: async () => {
      const { data, error } = await db()
        .from('memory_recovery_methods')
        .select('*')
        .eq('user_id', userId)
        .is('revoked_at', null);
      if (error)
        throw new Error(`Recovery method list failed: ${error.message}`);
      return (data ?? []).map(mapMethod);
    },

    revokeRecoveryMethod: async (methodId, now) => {
      const nowIso = (now ?? (() => new Date()))().toISOString();
      const { error } = await db()
        .from('memory_recovery_methods')
        .update({ revoked_at: nowIso })
        .eq('user_id', userId)
        .eq('method_id', methodId);
      if (error)
        throw new Error(`Recovery method revoke failed: ${error.message}`);
    },

    createRecoverySession: async (input: CreateRecoverySessionInput, now) => {
      const nowIso = (now ?? (() => new Date()))().toISOString();
      const record = {
        session_id: input.sessionId,
        user_id: userId,
        direction: input.direction,
        session: input.session,
        created_at: nowIso,
        expires_at: input.expiresAt,
        consumed_at: null,
        envelope: null,
      };
      const { data, error } = await db()
        .from('memory_recovery_sessions')
        .insert(record)
        .select('*')
        .single();
      if (error)
        throw new Error(`Recovery session create failed: ${error.message}`);
      return mapSession(data);
    },

    getRecoverySession: async (sessionId) => {
      const { data, error } = await db()
        .from('memory_recovery_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error)
        throw new Error(`Recovery session read failed: ${error.message}`);
      return data ? mapSession(data) : null;
    },

    submitRecoveryEnvelope: async (sessionId, envelope) => {
      const { error } = await db()
        .from('memory_recovery_sessions')
        .update({ envelope })
        .eq('user_id', userId)
        .eq('session_id', sessionId);
      if (error)
        throw new Error(`Recovery envelope submit failed: ${error.message}`);
    },

    consumeRecoverySession: async (sessionId, now) => {
      const { data, error } = await db()
        .from('memory_recovery_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error)
        throw new Error(`Recovery session read failed: ${error.message}`);
      if (!data)
        throw new RemoteMemoryError('not-found', 'Recovery session not found.');
      const record = mapSession(data);
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
        throw new RemoteMemoryError(
          'no-envelope',
          'No envelope submitted yet.',
        );
      const nowIso = (now ?? (() => new Date()))().toISOString();
      const { error: updateError } = await db()
        .from('memory_recovery_sessions')
        .update({ consumed_at: nowIso })
        .eq('user_id', userId)
        .eq('session_id', sessionId);
      if (updateError)
        throw new Error(
          `Recovery session consume failed: ${updateError.message}`,
        );
      return { session: record, envelope: record.envelope };
    },
  };
};

import {
  RemoteConflict,
  type CliAuthSessionRecord,
  type CliTokenRecord,
  type CloudEnvironmentRecord,
  type CloudEnvironmentVersionRecord,
  type CloudMachineRecord,
  type CloudProfile,
  type CloudRepository,
  type CloudSnapshotRecord,
  type CommitVersionInput,
  type CommitVersionOutcome,
} from '@stack/cloud-server';

import { serviceClient } from './supabase';

const mapProfile = (row: any): CloudProfile => ({
  userId: row.user_id,
  ...(row.github_username ? { githubUsername: row.github_username } : {}),
  ...(row.display_name ? { displayName: row.display_name } : {}),
  ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
});

const mapSession = (row: any): CliAuthSessionRecord => ({
  sessionId: row.session_id,
  userCode: row.user_code,
  deviceSecretHash: row.device_secret_hash,
  status: row.status,
  ...(row.user_id ? { userId: row.user_id } : {}),
  ...(row.machine_id ? { machineId: row.machine_id } : {}),
  ...(row.label ? { label: row.label } : {}),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const mapToken = (row: any): CliTokenRecord => ({
  tokenId: row.token_id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  ...(row.label ? { label: row.label } : {}),
  createdAt: row.created_at,
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

const mapEnvironment = (row: any): CloudEnvironmentRecord => ({
  environmentId: row.environment_id,
  userId: row.user_id,
  name: row.name,
  latestVersionId: row.latest_version_id ?? null,
  createdAt: row.created_at,
});

const mapVersion = (row: any): CloudEnvironmentVersionRecord => ({
  versionId: row.version_id,
  environmentId: row.environment_id,
  userId: row.user_id,
  versionNumber: row.version_number,
  digest: row.digest,
  bundle: row.bundle,
  ...(row.machine_id ? { machineId: row.machine_id } : {}),
  ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
  createdAt: row.created_at,
});

const mapSnapshot = (row: any): CloudSnapshotRecord => ({
  userId: row.user_id,
  contentHash: row.content_hash,
  archiveHash: row.archive_hash,
  byteSize: row.byte_size,
  createdAt: row.created_at,
});

/** Production {@link CloudRepository} backed by Supabase Postgres. */
export const supabaseRepository = (): CloudRepository => {
  const db = () => serviceClient();
  return {
    getProfile: async (userId) => {
      const { data } = await db()
        .from('profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      return data ? mapProfile(data) : null;
    },
    upsertProfile: async (profile) => {
      await db()
        .from('profiles')
        .upsert({
          user_id: profile.userId,
          github_username: profile.githubUsername ?? null,
          display_name: profile.displayName ?? null,
          avatar_url: profile.avatarUrl ?? null,
        });
    },

    createAuthSession: async (record) => {
      await db()
        .from('cli_auth_sessions')
        .insert({
          session_id: record.sessionId,
          user_code: record.userCode,
          device_secret_hash: record.deviceSecretHash,
          status: record.status,
          machine_id: record.machineId ?? null,
          label: record.label ?? null,
          created_at: record.createdAt,
          expires_at: record.expiresAt,
        });
    },
    findAuthSessionByDeviceHash: async (deviceSecretHash) => {
      const { data } = await db()
        .from('cli_auth_sessions')
        .select('*')
        .eq('device_secret_hash', deviceSecretHash)
        .maybeSingle();
      return data ? mapSession(data) : null;
    },
    findAuthSessionByUserCode: async (userCode) => {
      const { data } = await db()
        .from('cli_auth_sessions')
        .select('*')
        .eq('user_code', userCode)
        .maybeSingle();
      return data ? mapSession(data) : null;
    },
    updateAuthSession: async (sessionId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.userId !== undefined) row.user_id = patch.userId;
      await db()
        .from('cli_auth_sessions')
        .update(row)
        .eq('session_id', sessionId);
    },

    createToken: async (record) => {
      await db()
        .from('cli_tokens')
        .insert({
          token_id: record.tokenId,
          user_id: record.userId,
          token_hash: record.tokenHash,
          label: record.label ?? null,
          created_at: record.createdAt,
        });
    },
    findTokenByHash: async (tokenHash) => {
      const { data } = await db()
        .from('cli_tokens')
        .select('*')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      return data ? mapToken(data) : null;
    },
    updateToken: async (tokenId, patch) => {
      const row: Record<string, unknown> = {};
      if (patch.lastUsedAt !== undefined) row.last_used_at = patch.lastUsedAt;
      if (patch.revokedAt !== undefined) row.revoked_at = patch.revokedAt;
      await db().from('cli_tokens').update(row).eq('token_id', tokenId);
    },

    getEnvironmentByName: async (userId, name) => {
      const { data } = await db()
        .from('environments')
        .select('*')
        .eq('user_id', userId)
        .eq('name', name)
        .maybeSingle();
      return data ? mapEnvironment(data) : null;
    },
    getEnvironmentVersion: async (versionId) => {
      const { data } = await db()
        .from('environment_versions')
        .select('*')
        .eq('version_id', versionId)
        .maybeSingle();
      return data ? mapVersion(data) : null;
    },
    findVersionByIdempotencyKey: async (userId, idempotencyKey) => {
      const { data } = await db()
        .from('environment_versions')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      return data ? mapVersion(data) : null;
    },
    commitEnvironmentVersion: async (
      input: CommitVersionInput,
    ): Promise<CommitVersionOutcome> => {
      const { data, error } = await db().rpc('commit_environment_version', {
        p_user_id: input.userId,
        p_name: input.name,
        p_bundle: input.bundle,
        p_digest: input.digest,
        p_expected_latest_version_id: input.expectedLatestVersionId,
        p_machine_id: input.machineId ?? null,
        p_idempotency_key: input.idempotencyKey ?? null,
        p_environment_id: input.ids.environmentId,
        p_version_id: input.ids.versionId,
        p_now: input.now,
      });
      if (error) {
        if (error.message.includes('STACK_REMOTE_CONFLICT'))
          throw new RemoteConflict('Remote Environment version changed.');
        throw new Error(`Version commit failed: ${error.message}`);
      }
      const result = data as any;
      return {
        environment: mapEnvironment(result.environment),
        version: mapVersion(result.version),
        createdNew: result.created_new,
      };
    },

    hasSnapshot: async (userId, contentHash) => {
      const { data } = await db()
        .from('snapshots')
        .select('content_hash')
        .eq('user_id', userId)
        .eq('content_hash', contentHash)
        .maybeSingle();
      return Boolean(data);
    },
    getSnapshot: async (userId, contentHash) => {
      const { data } = await db()
        .from('snapshots')
        .select('*')
        .eq('user_id', userId)
        .eq('content_hash', contentHash)
        .maybeSingle();
      return data ? mapSnapshot(data) : null;
    },
    putSnapshot: async (record) => {
      await db().from('snapshots').upsert({
        user_id: record.userId,
        content_hash: record.contentHash,
        archive_hash: record.archiveHash,
        byte_size: record.byteSize,
        created_at: record.createdAt,
      });
    },

    upsertMachine: async (record: CloudMachineRecord) => {
      await db()
        .from('machines')
        .upsert({
          user_id: record.userId,
          machine_id: record.machineId,
          platform: record.platform ?? null,
          arch: record.arch ?? null,
          first_seen_at: record.firstSeenAt,
          last_synced_at: record.lastSyncedAt ?? null,
        });
    },
  };
};

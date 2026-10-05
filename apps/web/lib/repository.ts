import {
  PublicStackConflict,
  RemoteConflict,
  type CliAuthSessionRecord,
  type CliTokenRecord,
  type CloudEnvironmentRecord,
  type CloudEnvironmentVersionRecord,
  type CloudMachineRecord,
  type CloudProjectRecord,
  type CloudProfile,
  type CloudRepository,
  type CloudSnapshotRecord,
  type CommitPublicVersionInput,
  type CommitPublicVersionOutcome,
  type CommitVersionInput,
  type CommitVersionOutcome,
  type PublicHandleRecord,
  type PublicStackRecord,
  type PublicStackRepository,
  type PublicStackVersionRecord,
} from '@stack/cloud-server';

import { serviceClient } from './supabase';

const mapPublicStack = (row: any): PublicStackRecord => ({
  stackId: row.stack_id,
  ownerUserId: row.owner_user_id,
  ownerHandle: row.owner_handle,
  slug: row.slug,
  displayName: row.display_name,
  description: row.description,
  latestVersionId: row.latest_version_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapPublicVersion = (row: any): PublicStackVersionRecord => ({
  versionId: row.version_id,
  stackId: row.stack_id,
  ownerUserId: row.owner_user_id,
  versionNumber: row.version_number,
  versionHash: row.version_hash,
  digest: row.digest,
  bundle: row.bundle,
  displayName: row.display_name,
  description: row.description,
  ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
  createdAt: row.created_at,
});

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
  ...(row.machine_id ? { machineId: row.machine_id } : {}),
  createdAt: row.created_at,
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

const mapProject = (row: any): CloudProjectRecord => ({
  userId: row.user_id,
  projectId: row.project_id,
  lifecycle: row.lifecycle,
  ...(row.name != null ? { name: row.name } : {}),
  updatedAt: row.updated_at,
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

/** Production repository backed by Supabase Postgres. */
export const supabaseRepository = (): CloudRepository &
  PublicStackRepository => {
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
          machine_id: record.machineId ?? null,
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

    // Phase P1: upsert the machine row (preserving first_seen_at) and REPLACE its
    // skill versions + project presence. Presence only — no filesystem paths stored.
    recordCheckin: async (input) => {
      await db()
        .from('machines')
        .upsert(
          {
            user_id: input.userId,
            machine_id: input.machineId,
            name: input.name ?? null,
            platform: input.platform ?? null,
            arch: input.arch ?? null,
            agents_detected: input.agentsDetected ?? [],
            last_checkin_at: input.now,
            memory_backed_up: input.memoryBackedUp,
            first_seen_at: input.now,
          },
          { onConflict: 'user_id,machine_id', ignoreDuplicates: false },
        );
      await db()
        .from('machine_skill_versions')
        .delete()
        .eq('user_id', input.userId)
        .eq('machine_id', input.machineId);
      if (input.skills.length > 0)
        await db()
          .from('machine_skill_versions')
          .insert(
            input.skills.map((s) => ({
              user_id: input.userId,
              machine_id: input.machineId,
              skill_id: s.skillId,
              installed_version: s.installedVersion,
            })),
          );
      await db()
        .from('machine_project_presence')
        .delete()
        .eq('user_id', input.userId)
        .eq('machine_id', input.machineId);
      if (input.projects.length > 0)
        await db()
          .from('machine_project_presence')
          .insert(
            input.projects.map((p) => ({
              user_id: input.userId,
              machine_id: input.machineId,
              project_id: p.projectId,
              present: p.present,
            })),
          );
    },
    listMachineStates: async (userId) => {
      const [machinesRes, skillsRes, presenceRes] = await Promise.all([
        db().from('machines').select('*').eq('user_id', userId),
        db().from('machine_skill_versions').select('*').eq('user_id', userId),
        db().from('machine_project_presence').select('*').eq('user_id', userId),
      ]);
      const rows = (machinesRes.data as any[] | null) ?? [];
      const skills = (skillsRes.data as any[] | null) ?? [];
      const presence = (presenceRes.data as any[] | null) ?? [];
      return rows.map((m) => ({
        userId: m.user_id,
        machineId: m.machine_id,
        firstSeenAt: m.first_seen_at,
        ...(m.name != null ? { name: m.name } : {}),
        ...(m.platform != null ? { platform: m.platform } : {}),
        ...(m.arch != null ? { arch: m.arch } : {}),
        ...(m.last_synced_at != null ? { lastSyncedAt: m.last_synced_at } : {}),
        ...(m.last_checkin_at != null
          ? { lastCheckinAt: m.last_checkin_at }
          : {}),
        ...(m.agents_detected != null
          ? { agentsDetected: m.agents_detected as string[] }
          : {}),
        ...(m.memory_backed_up != null
          ? { memoryBackedUp: m.memory_backed_up as boolean }
          : {}),
        ...(m.revoked_at != null ? { revokedAt: m.revoked_at } : {}),
        skills: skills
          .filter((s) => s.machine_id === m.machine_id)
          .map((s) => ({
            skillId: s.skill_id,
            installedVersion: s.installed_version,
          })),
        projects: presence
          .filter((p) => p.machine_id === m.machine_id)
          .map((p) => ({ projectId: p.project_id, present: p.present })),
      }));
    },

    /* ------------------------------- Phase P3 ------------------------------- */
    listEnvironmentVersions: async (userId, name) => {
      const environment = await db()
        .from('environments')
        .select('environment_id')
        .eq('user_id', userId)
        .eq('name', name)
        .maybeSingle();
      const environmentId = (environment.data as any)?.environment_id;
      if (!environmentId) return [];
      const { data } = await db()
        .from('environment_versions')
        .select('*')
        .eq('user_id', userId)
        .eq('environment_id', environmentId)
        .order('version_number', { ascending: false });
      return ((data as any[] | null) ?? []).map(mapVersion);
    },
    revokeMachine: async (userId, machineId, now) => {
      const { data } = await db()
        .from('machines')
        .update({ revoked_at: now })
        .eq('user_id', userId)
        .eq('machine_id', machineId)
        .select('machine_id');
      if (!data || (data as any[]).length === 0) return null;
      const revoked = await db()
        .from('cli_tokens')
        .update({ revoked_at: now })
        .eq('user_id', userId)
        .eq('machine_id', machineId)
        .is('revoked_at', null)
        .select('token_id');
      return {
        machineId,
        revokedTokens: ((revoked.data as any[] | null) ?? []).length,
      };
    },
    listProjects: async (userId) => {
      const { data } = await db()
        .from('cloud_projects')
        .select('*')
        .eq('user_id', userId)
        .order('project_id', { ascending: true });
      return ((data as any[] | null) ?? []).map(mapProject);
    },
    syncProjects: async (userId, projects, now) => {
      if (projects.length === 0) return;
      await db()
        .from('cloud_projects')
        .upsert(
          projects.map((project) => ({
            user_id: userId,
            project_id: project.projectId,
            lifecycle: project.lifecycle,
            name: project.name ?? null,
            updated_at: now,
          })),
          { onConflict: 'user_id,project_id' },
        );
    },
    setProjectLifecycle: async (userId, projectId, lifecycle, now) => {
      const { data } = await db()
        .from('cloud_projects')
        .update({ lifecycle, updated_at: now })
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .select('*')
        .maybeSingle();
      return data ? mapProject(data) : null;
    },

    /* ---------------------------- public stacks --------------------------- */
    getHandleForUser: async (userId) => {
      const { data } = await db()
        .from('public_handles')
        .select('handle')
        .eq('user_id', userId)
        .maybeSingle();
      return (data?.handle as string | undefined) ?? null;
    },
    findHandleOwner: async (handle) => {
      const { data } = await db()
        .from('public_handles')
        .select('user_id')
        .eq('handle', handle)
        .maybeSingle();
      return (data?.user_id as string | undefined) ?? null;
    },
    reserveHandle: async (record: PublicHandleRecord) => {
      const { error } = await db().from('public_handles').insert({
        user_id: record.userId,
        handle: record.handle,
        created_at: record.createdAt,
      });
      if (error) throw new PublicStackConflict('Handle already reserved.');
    },
    getProfileByHandle: async (handle) => {
      const { data } = await db()
        .from('public_handles')
        .select('user_id')
        .eq('handle', handle)
        .maybeSingle();
      if (!data?.user_id) return null;
      const { data: profile } = await db()
        .from('profiles')
        .select('*')
        .eq('user_id', data.user_id)
        .maybeSingle();
      return profile ? mapProfile(profile) : null;
    },
    getPublicStackByHandleSlug: async (handle, slug) => {
      const { data } = await db()
        .from('public_stacks')
        .select('*')
        .eq('owner_handle', handle)
        .eq('slug', slug)
        .maybeSingle();
      return data ? mapPublicStack(data) : null;
    },
    getPublicStackByOwner: async (ownerUserId, slug) => {
      const { data } = await db()
        .from('public_stacks')
        .select('*')
        .eq('owner_user_id', ownerUserId)
        .eq('slug', slug)
        .maybeSingle();
      return data ? mapPublicStack(data) : null;
    },
    getPublicStackVersionById: async (versionId) => {
      const { data } = await db()
        .from('public_stack_versions')
        .select('*')
        .eq('version_id', versionId)
        .maybeSingle();
      return data ? mapPublicVersion(data) : null;
    },
    getPublicStackVersionByNumber: async (stackId, versionNumber) => {
      const { data } = await db()
        .from('public_stack_versions')
        .select('*')
        .eq('stack_id', stackId)
        .eq('version_number', versionNumber)
        .maybeSingle();
      return data ? mapPublicVersion(data) : null;
    },
    findPublicVersionByIdempotencyKey: async (ownerUserId, idempotencyKey) => {
      const { data } = await db()
        .from('public_stack_versions')
        .select('*')
        .eq('owner_user_id', ownerUserId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      return data ? mapPublicVersion(data) : null;
    },
    commitPublicStackVersion: async (
      input: CommitPublicVersionInput,
    ): Promise<CommitPublicVersionOutcome> => {
      const { data, error } = await db().rpc('commit_public_stack_version', {
        p_owner_user_id: input.ownerUserId,
        p_owner_handle: input.ownerHandle,
        p_slug: input.slug,
        p_display_name: input.displayName,
        p_description: input.description,
        p_bundle: input.bundle,
        p_digest: input.digest,
        p_version_hash: input.versionHash,
        p_expected_latest_version_id: input.expectedLatestVersionId,
        p_idempotency_key: input.idempotencyKey ?? null,
        p_stack_id: input.ids.stackId,
        p_version_id: input.ids.versionId,
        p_now: input.now,
      });
      if (error) {
        if (error.message.includes('STACK_PUBLIC_CONFLICT'))
          throw new PublicStackConflict('Public Stack version changed.');
        throw new Error(`Public version commit failed: ${error.message}`);
      }
      const result = data as any;
      return {
        stack: mapPublicStack(result.stack),
        version: mapPublicVersion(result.version),
        createdNew: result.created_new,
      };
    },
    listPublicStacksByHandle: async (handle) => {
      const { data } = await db()
        .from('public_stacks')
        .select('*')
        .eq('owner_handle', handle)
        .order('slug', { ascending: true });
      return ((data as any[]) ?? []).map(mapPublicStack);
    },
  };
};

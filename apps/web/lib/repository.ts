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
  type SkillReviewCheckRecord,
  type CommitUserStackVersionInput,
  type CommitUserStackVersionOutcome,
  type UserStackRecord,
  type UserStackRepository,
  type UserStackVersionRecord,
  UserStackConflict,
  UserStackNameConflict,
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
  unpublishedAt: row.unpublished_at ?? null,
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

const mapUserStack = (row: any): UserStackRecord => ({
  stackId: row.stack_id,
  userId: row.user_id,
  name: row.name,
  latestVersionId: row.latest_version_id ?? null,
  publishedSlug: row.published_slug ?? null,
  createdAt: row.created_at,
});

const mapUserStackVersion = (row: any): UserStackVersionRecord => ({
  versionId: row.version_id,
  stackId: row.stack_id,
  userId: row.user_id,
  versionNumber: row.version_number,
  digest: row.digest,
  bundle: row.bundle,
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

const mapSkillReviewCheck = (row: any): SkillReviewCheckRecord => ({
  userId: row.user_id,
  skillId: row.skill_id,
  approvedContentHash: row.approved_content_hash,
  sourceCheckState: row.source_check_state,
  checkedAt: row.checked_at,
  ...(row.cannot_check_reason
    ? { cannotCheckReason: row.cannot_check_reason }
    : {}),
  ...(row.check_failed_reason
    ? { checkFailedReason: row.check_failed_reason }
    : {}),
  ...(row.review_unavailable_reason
    ? { reviewUnavailableReason: row.review_unavailable_reason }
    : {}),
  ...(row.candidate_revision
    ? { candidateRevision: row.candidate_revision }
    : {}),
  ...(row.candidate_content_hash
    ? { candidateContentHash: row.candidate_content_hash }
    : {}),
  ...(row.review_artifact_id
    ? { reviewArtifactId: row.review_artifact_id }
    : {}),
  ...(row.artifact_payload_hash
    ? { artifactPayloadHash: row.artifact_payload_hash }
    : {}),
  ...(row.diff_files ? { diffFiles: row.diff_files } : {}),
  ...(row.pending_cleanup_artifact_ids?.length
    ? { pendingCleanupArtifactIds: row.pending_cleanup_artifact_ids }
    : {}),
});

/** Production repository backed by Supabase Postgres. */
export const supabaseRepository = (): CloudRepository &
  PublicStackRepository &
  UserStackRepository => {
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

    getSkillReviewCheck: async (userId, skillId) => {
      const { data } = await db()
        .from('skill_review_checks')
        .select('*')
        .eq('user_id', userId)
        .eq('skill_id', skillId)
        .maybeSingle();
      return data ? mapSkillReviewCheck(data) : null;
    },
    putSkillReviewCheck: async (record) => {
      await db()
        .from('skill_review_checks')
        .upsert({
          user_id: record.userId,
          skill_id: record.skillId,
          approved_content_hash: record.approvedContentHash,
          source_check_state: record.sourceCheckState,
          checked_at: record.checkedAt,
          cannot_check_reason: record.cannotCheckReason ?? null,
          check_failed_reason: record.checkFailedReason ?? null,
          review_unavailable_reason: record.reviewUnavailableReason ?? null,
          candidate_revision: record.candidateRevision ?? null,
          candidate_content_hash: record.candidateContentHash ?? null,
          review_artifact_id: record.reviewArtifactId ?? null,
          artifact_payload_hash: record.artifactPayloadHash ?? null,
          diff_files: record.diffFiles ?? null,
          // Explicitly null when clearing — this is a full-row upsert, so an omitted field
          // would leave a stale value from a prior row state rather than actually clearing it.
          pending_cleanup_artifact_ids:
            record.pendingCleanupArtifactIds ?? null,
        });
    },
    deleteSkillReviewCheck: async (userId, skillId) => {
      await db()
        .from('skill_review_checks')
        .delete()
        .eq('user_id', userId)
        .eq('skill_id', skillId);
    },

    upsertMachine: async (record: CloudMachineRecord) => {
      // Preserve the ORIGINAL authorization time: a later login/push must not reset
      // first_seen_at to "now" (it previously did — that corrupted the audit trail and the
      // never-checked-in staleness/sort rules that key off it).
      const { data: existingRow } = await db()
        .from('machines')
        .select('first_seen_at')
        .eq('user_id', record.userId)
        .eq('machine_id', record.machineId)
        .maybeSingle();
      const preservedFirstSeenAt =
        (existingRow as { first_seen_at?: string } | null)?.first_seen_at ??
        record.firstSeenAt;
      await db()
        .from('machines')
        .upsert({
          user_id: record.userId,
          machine_id: record.machineId,
          platform: record.platform ?? null,
          arch: record.arch ?? null,
          first_seen_at: preservedFirstSeenAt,
          last_synced_at: record.lastSyncedAt ?? null,
        });
    },

    // Phase P1/P4: upsert the machine row (preserving first_seen_at AND an existing non-empty
    // friendly name) and REPLACE its skill versions + project presence. Presence only — no
    // filesystem paths stored. Friendly-name contract: on first check-in with no name yet,
    // populate it from the reported hostname; a later automatic check-in never overwrites a
    // name that is already set.
    recordCheckin: async (input) => {
      const { data: existingRow } = await db()
        .from('machines')
        .select('name, first_seen_at')
        .eq('user_id', input.userId)
        .eq('machine_id', input.machineId)
        .maybeSingle();
      const existing = existingRow as {
        name: string | null;
        first_seen_at: string;
      } | null;
      const existingName = existing?.name ?? null;
      const nextName =
        existingName !== null && existingName.trim().length > 0
          ? existingName
          : (input.name ?? null);
      const preservedFirstSeenAt = existing?.first_seen_at ?? input.now;
      await db()
        .from('machines')
        .upsert(
          {
            user_id: input.userId,
            machine_id: input.machineId,
            name: nextName,
            platform: input.platform ?? null,
            arch: input.arch ?? null,
            agents_detected: input.agentsDetected ?? [],
            last_checkin_at: input.now,
            memory_backed_up: input.memoryBackedUp,
            first_seen_at: preservedFirstSeenAt,
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
      // Discovery only: omit `lifecycle` from the upsert so ON CONFLICT updates name/updated_at
      // but PRESERVES an existing row's lifecycle; a newly-inserted row takes the column default
      // ('active'). A stale local machine therefore can never unarchive a web-archived Project.
      await db()
        .from('cloud_projects')
        .upsert(
          projects.map((project) => ({
            user_id: userId,
            project_id: project.projectId,
            name: project.name ?? null,
            updated_at: now,
          })),
          { onConflict: 'user_id,project_id' },
        );
    },
    bindTokenMachine: async (tokenId, machineId) => {
      // Bind only when currently unbound (migration-on-first-use); never rebind.
      const { data } = await db()
        .from('cli_tokens')
        .update({ machine_id: machineId })
        .eq('token_id', tokenId)
        .is('machine_id', null)
        .select('token_id');
      return ((data as unknown[] | null) ?? []).length > 0;
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
    unpublishPublicStack: async (ownerUserId, slug, now) => {
      const { data, error } = await db().rpc('unpublish_public_stack', {
        p_owner_user_id: ownerUserId,
        p_slug: slug,
        p_now: now,
      });
      if (error)
        throw new Error(`Could not unpublish this share: ${error.message}`);
      return data ? mapPublicStack(data as any) : null;
    },
    reactivatePublicStack: async (ownerUserId, slug, now) => {
      const { data, error } = await db().rpc('reactivate_public_stack', {
        p_owner_user_id: ownerUserId,
        p_slug: slug,
        p_now: now,
      });
      if (error)
        throw new Error(`Could not reactivate this share: ${error.message}`);
      return data ? mapPublicStack(data as any) : null;
    },

    /* ------------------------------ Phase P10B ------------------------------ */
    listUserStacks: async (userId) => {
      const { data } = await db()
        .from('user_stacks')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true });
      return ((data as any[] | null) ?? []).map(mapUserStack);
    },
    getUserStackByName: async (userId, name) => {
      const { data } = await db()
        .from('user_stacks')
        .select('*')
        .eq('user_id', userId)
        .eq('name', name)
        .maybeSingle();
      return data ? mapUserStack(data) : null;
    },
    getUserStackById: async (userId, stackId) => {
      const { data } = await db()
        .from('user_stacks')
        .select('*')
        .eq('user_id', userId)
        .eq('stack_id', stackId)
        .maybeSingle();
      return data ? mapUserStack(data) : null;
    },
    // Owner-scoped by design (spec P10 correction §8) — filters by user_id in addition to
    // version_id, so a guessed/known version id can never resolve another account's version.
    getUserStackVersion: async (userId, versionId) => {
      const { data } = await db()
        .from('user_stack_versions')
        .select('*')
        .eq('user_id', userId)
        .eq('version_id', versionId)
        .maybeSingle();
      return data ? mapUserStackVersion(data) : null;
    },
    commitUserStackVersion: async (
      input: CommitUserStackVersionInput,
    ): Promise<CommitUserStackVersionOutcome> => {
      const { data, error } = await db().rpc('commit_user_stack_version', {
        p_user_id: input.userId,
        p_name: input.name,
        p_bundle: input.bundle,
        p_digest: input.digest,
        p_expected_latest_version_id: input.expectedLatestVersionId,
        p_stack_id: input.ids.stackId,
        p_version_id: input.ids.versionId,
        p_now: input.now,
      });
      if (error) {
        if (error.message.includes('STACK_REMOTE_CONFLICT'))
          throw new UserStackConflict('Named Stack version changed.');
        throw new Error(`Named Stack version commit failed: ${error.message}`);
      }
      const result = data as any;
      return {
        stack: mapUserStack(result.stack),
        version: mapUserStackVersion(result.version),
        createdNew: result.created_new,
      };
    },
    renameUserStack: async (userId, stackId, name) => {
      const { data, error } = await db()
        .from('user_stacks')
        .update({ name })
        .eq('user_id', userId)
        .eq('stack_id', stackId)
        .select('*')
        .maybeSingle();
      if (error) {
        // Postgres unique_violation on (user_id, name).
        if ((error as { code?: string }).code === '23505')
          throw new UserStackNameConflict(
            `A Stack named "${name}" already exists.`,
          );
        throw new Error(`Named Stack rename failed: ${error.message}`);
      }
      return data ? mapUserStack(data) : null;
    },
    markUserStackPublished: async (userId, stackId, slug) => {
      const { data, error } = await db()
        .from('user_stacks')
        .update({ published_slug: slug })
        .eq('user_id', userId)
        .eq('stack_id', stackId)
        .select('*')
        .maybeSingle();
      if (error)
        throw new Error(
          `Could not record named-Stack publication: ${error.message}`,
        );
      return data ? mapUserStack(data) : null;
    },
  };
};

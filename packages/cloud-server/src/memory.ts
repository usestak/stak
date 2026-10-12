import {
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  type RemoteMemoryBackend,
} from '@stack/memory';

import {
  PublicStackConflict,
  RemoteConflict,
  type CliAuthSessionRecord,
  type CliTokenRecord,
  type CloudBlobStore,
  type CloudEnvironmentRecord,
  type CloudEnvironmentVersionRecord,
  type CloudMachineRecord,
  type CloudProjectRecord,
  type MachineSkillVersionRecord,
  type MachineProjectPresenceRecord,
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
} from './repository.js';

const key = (userId: string, value: string) => `${userId} ${value}`;

export const createInMemoryRepository = (): CloudRepository &
  PublicStackRepository &
  UserStackRepository & {
    snapshots: Map<string, CloudSnapshotRecord>;
    publicStacks: Map<string, PublicStackRecord>;
  } => {
  const profiles = new Map<string, CloudProfile>();
  const sessions = new Map<string, CliAuthSessionRecord>();
  const tokens = new Map<string, CliTokenRecord>();
  const environments = new Map<string, CloudEnvironmentRecord>();
  const versions = new Map<string, CloudEnvironmentVersionRecord>();
  const snapshots = new Map<string, CloudSnapshotRecord>();
  const machines = new Map<string, CloudMachineRecord>();
  const machineSkills = new Map<string, MachineSkillVersionRecord[]>();
  const machineProjects = new Map<string, MachineProjectPresenceRecord[]>();
  const projects = new Map<string, CloudProjectRecord>();
  const handlesByUser = new Map<string, PublicHandleRecord>();
  const handleOwners = new Map<string, string>();
  const publicStacks = new Map<string, PublicStackRecord>();
  const publicVersions = new Map<string, PublicStackVersionRecord>();
  const skillReviewChecks = new Map<string, SkillReviewCheckRecord>();
  const userStacks = new Map<string, UserStackRecord>();
  const userStackVersions = new Map<string, UserStackVersionRecord>();

  const envKey = (userId: string, name: string) => key(userId, name);
  const userStackKey = (userId: string, name: string) => key(userId, name);
  const stackKey = (ownerUserId: string, slug: string) =>
    key(ownerUserId, slug);
  const checkKey = (userId: string, skillId: string) => `${userId}:${skillId}`;

  return {
    snapshots,
    publicStacks,
    getProfile: async (userId) => profiles.get(userId) ?? null,
    upsertProfile: async (profile) => {
      profiles.set(profile.userId, profile);
    },

    createAuthSession: async (record) => {
      sessions.set(record.sessionId, { ...record });
    },
    findAuthSessionByDeviceHash: async (deviceSecretHash) =>
      [...sessions.values()].find(
        (session) => session.deviceSecretHash === deviceSecretHash,
      ) ?? null,
    findAuthSessionByUserCode: async (userCode) =>
      [...sessions.values()].find((session) => session.userCode === userCode) ??
      null,
    updateAuthSession: async (sessionId, patch) => {
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...patch });
    },

    createToken: async (record) => {
      tokens.set(record.tokenId, { ...record });
    },
    findTokenByHash: async (tokenHash) =>
      [...tokens.values()].find((token) => token.tokenHash === tokenHash) ??
      null,
    updateToken: async (tokenId, patch) => {
      const existing = tokens.get(tokenId);
      if (existing) tokens.set(tokenId, { ...existing, ...patch });
    },

    getEnvironmentByName: async (userId, name) =>
      environments.get(envKey(userId, name)) ?? null,
    getEnvironmentVersion: async (versionId) => versions.get(versionId) ?? null,
    findVersionByIdempotencyKey: async (userId, idempotencyKey) =>
      [...versions.values()].find(
        (version) =>
          version.userId === userId &&
          version.idempotencyKey === idempotencyKey,
      ) ?? null,

    commitEnvironmentVersion: async (
      input: CommitVersionInput,
    ): Promise<CommitVersionOutcome> => {
      const existing = environments.get(envKey(input.userId, input.name));
      const currentLatest = existing?.latestVersionId ?? null;
      if (currentLatest !== input.expectedLatestVersionId)
        throw new RemoteConflict(
          `Expected latest version ${input.expectedLatestVersionId ?? 'none'}, but it is ${currentLatest ?? 'none'}.`,
        );
      const environment: CloudEnvironmentRecord = existing ?? {
        environmentId: input.ids.environmentId,
        userId: input.userId,
        name: input.name,
        latestVersionId: null,
        createdAt: input.now,
      };
      const previousNumber = currentLatest
        ? (versions.get(currentLatest)?.versionNumber ?? 0)
        : 0;
      const version: CloudEnvironmentVersionRecord = {
        versionId: input.ids.versionId,
        environmentId: environment.environmentId,
        userId: input.userId,
        versionNumber: previousNumber + 1,
        digest: input.digest,
        bundle: input.bundle,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        createdAt: input.now,
      };
      versions.set(version.versionId, version);
      const updated: CloudEnvironmentRecord = {
        ...environment,
        latestVersionId: version.versionId,
      };
      environments.set(envKey(input.userId, input.name), updated);
      return { environment: updated, version, createdNew: !existing };
    },

    hasSnapshot: async (userId, contentHash) =>
      snapshots.has(key(userId, contentHash)),
    getSnapshot: async (userId, contentHash) =>
      snapshots.get(key(userId, contentHash)) ?? null,
    putSnapshot: async (record) => {
      snapshots.set(key(record.userId, record.contentHash), { ...record });
    },

    upsertMachine: async (record) => {
      const k = key(record.userId, record.machineId);
      const existing = machines.get(k);
      // Merge onto the existing row: upsertMachine (login/push) never reports name,
      // agentsDetected, lastCheckinAt, memoryBackedUp, or revokedAt, so spreading `existing`
      // first means those fields survive a later login/push instead of being wiped to
      // undefined. firstSeenAt always prefers the ORIGINAL authorization time.
      machines.set(k, {
        ...existing,
        ...record,
        firstSeenAt: existing?.firstSeenAt ?? record.firstSeenAt,
      });
    },

    recordCheckin: async (input) => {
      const k = key(input.userId, input.machineId);
      const existing = machines.get(k);
      // Friendly-name contract (P4): on first check-in, if the machine has no name yet,
      // populate it from the reported hostname. A later automatic check-in must NEVER
      // overwrite an existing non-empty friendly name (a rename, if ever added, is a
      // distinct explicit action — not something a routine check-in should undo).
      const existingName = existing?.name;
      const nextName =
        existingName !== undefined && existingName.trim().length > 0
          ? existingName
          : input.name;
      machines.set(k, {
        ...existing,
        userId: input.userId,
        machineId: input.machineId,
        firstSeenAt: existing?.firstSeenAt ?? input.now,
        lastCheckinAt: input.now,
        memoryBackedUp: input.memoryBackedUp,
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.arch !== undefined ? { arch: input.arch } : {}),
        ...(input.agentsDetected !== undefined
          ? { agentsDetected: input.agentsDetected }
          : {}),
      });
      // Replace (not merge) the machine's reported skills and project presence.
      machineSkills.set(
        k,
        input.skills.map((s) => ({ ...s })),
      );
      machineProjects.set(
        k,
        input.projects.map((p) => ({ ...p })),
      );
    },
    listMachineStates: async (userId) =>
      [...machines.values()]
        .filter((m) => m.userId === userId)
        .map((m) => {
          const k = key(m.userId, m.machineId);
          return {
            ...m,
            skills: (machineSkills.get(k) ?? []).map((s) => ({ ...s })),
            projects: (machineProjects.get(k) ?? []).map((p) => ({ ...p })),
          };
        }),

    /* ------------------------------ Phase P3 ------------------------------ */
    listEnvironmentVersions: async (userId, name) => {
      const environment = environments.get(envKey(userId, name));
      if (!environment) return [];
      return [...versions.values()]
        .filter(
          (v) =>
            v.userId === userId &&
            v.environmentId === environment.environmentId,
        )
        .sort((a, b) => b.versionNumber - a.versionNumber);
    },
    revokeMachine: async (userId, machineId, now) => {
      const machine = machines.get(key(userId, machineId));
      if (!machine || machine.userId !== userId) return null;
      machines.set(key(userId, machineId), { ...machine, revokedAt: now });
      let revokedTokens = 0;
      for (const [tokenId, token] of tokens)
        if (
          token.userId === userId &&
          token.machineId === machineId &&
          !token.revokedAt
        ) {
          tokens.set(tokenId, { ...token, revokedAt: now });
          revokedTokens += 1;
        }
      return { machineId, revokedTokens };
    },
    listProjects: async (userId) =>
      [...projects.values()]
        .filter((p) => p.userId === userId)
        .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    syncProjects: async (userId, incoming, now) => {
      for (const project of incoming) {
        const k = key(userId, project.projectId);
        const existing = projects.get(k);
        // Discovery only: NEVER change an existing row's lifecycle; a new row defaults active.
        projects.set(k, {
          userId,
          projectId: project.projectId,
          lifecycle: existing?.lifecycle ?? 'active',
          ...(project.name !== undefined ? { name: project.name } : {}),
          updatedAt: now,
        });
      }
    },
    bindTokenMachine: async (tokenId, machineId) => {
      const existing = tokens.get(tokenId);
      if (!existing || existing.machineId !== undefined) return false;
      tokens.set(tokenId, { ...existing, machineId });
      return true;
    },
    setProjectLifecycle: async (userId, projectId, lifecycle, now) => {
      const existing = projects.get(key(userId, projectId));
      if (!existing || existing.userId !== userId) return null;
      const updated: CloudProjectRecord = {
        ...existing,
        lifecycle,
        updatedAt: now,
      };
      projects.set(key(userId, projectId), updated);
      return updated;
    },

    /* ---------------------------- public stacks --------------------------- */
    getHandleForUser: async (userId) =>
      handlesByUser.get(userId)?.handle ?? null,
    findHandleOwner: async (handle) => handleOwners.get(handle) ?? null,
    reserveHandle: async (record) => {
      if (handleOwners.has(record.handle))
        throw new PublicStackConflict('Handle already reserved.');
      handleOwners.set(record.handle, record.userId);
      handlesByUser.set(record.userId, { ...record });
    },
    getProfileByHandle: async (handle) => {
      const userId = handleOwners.get(handle);
      return userId ? (profiles.get(userId) ?? null) : null;
    },
    getPublicStackByHandleSlug: async (handle, slug) => {
      const userId = handleOwners.get(handle);
      return userId ? (publicStacks.get(stackKey(userId, slug)) ?? null) : null;
    },
    getPublicStackByOwner: async (ownerUserId, slug) =>
      publicStacks.get(stackKey(ownerUserId, slug)) ?? null,
    getPublicStackVersionById: async (versionId) =>
      publicVersions.get(versionId) ?? null,
    getPublicStackVersionByNumber: async (stackId, versionNumber) =>
      [...publicVersions.values()].find(
        (version) =>
          version.stackId === stackId &&
          version.versionNumber === versionNumber,
      ) ?? null,
    findPublicVersionByIdempotencyKey: async (ownerUserId, idempotencyKey) =>
      [...publicVersions.values()].find(
        (version) =>
          version.ownerUserId === ownerUserId &&
          version.idempotencyKey === idempotencyKey,
      ) ?? null,
    commitPublicStackVersion: async (
      input: CommitPublicVersionInput,
    ): Promise<CommitPublicVersionOutcome> => {
      const existing = publicStacks.get(
        stackKey(input.ownerUserId, input.slug),
      );
      const currentLatest = existing?.latestVersionId ?? null;
      if (currentLatest !== input.expectedLatestVersionId)
        throw new PublicStackConflict(
          `Expected latest version ${input.expectedLatestVersionId ?? 'none'}, but it is ${currentLatest ?? 'none'}.`,
        );
      const stack: PublicStackRecord = existing ?? {
        stackId: input.ids.stackId,
        ownerUserId: input.ownerUserId,
        ownerHandle: input.ownerHandle,
        slug: input.slug,
        displayName: input.displayName,
        description: input.description,
        latestVersionId: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const previousNumber = currentLatest
        ? (publicVersions.get(currentLatest)?.versionNumber ?? 0)
        : 0;
      const version: PublicStackVersionRecord = {
        versionId: input.ids.versionId,
        stackId: stack.stackId,
        ownerUserId: input.ownerUserId,
        versionNumber: previousNumber + 1,
        versionHash: input.versionHash,
        digest: input.digest,
        bundle: input.bundle,
        displayName: input.displayName,
        description: input.description,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        createdAt: input.now,
      };
      publicVersions.set(version.versionId, version);
      const updated: PublicStackRecord = {
        ...stack,
        displayName: input.displayName,
        description: input.description,
        latestVersionId: version.versionId,
        updatedAt: input.now,
      };
      publicStacks.set(stackKey(input.ownerUserId, input.slug), updated);
      return { stack: updated, version, createdNew: !existing };
    },
    listPublicStacksByHandle: async (handle) => {
      const userId = handleOwners.get(handle);
      if (!userId) return [];
      return [...publicStacks.values()]
        .filter((stack) => stack.ownerUserId === userId)
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },

    /* ------------------------------ Phase P5a ------------------------------ */
    getSkillReviewCheck: async (userId, skillId) =>
      skillReviewChecks.get(checkKey(userId, skillId)) ?? null,
    putSkillReviewCheck: async (record) => {
      skillReviewChecks.set(checkKey(record.userId, record.skillId), record);
    },
    deleteSkillReviewCheck: async (userId, skillId) => {
      skillReviewChecks.delete(checkKey(userId, skillId));
    },

    /* ------------------------------ Phase P10B ------------------------------ */
    listUserStacks: async (userId) =>
      [...userStacks.values()]
        .filter((stack) => stack.userId === userId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    getUserStackByName: async (userId, name) =>
      userStacks.get(userStackKey(userId, name)) ?? null,
    getUserStackById: async (userId, stackId) =>
      [...userStacks.values()].find(
        (stack) => stack.userId === userId && stack.stackId === stackId,
      ) ?? null,
    getUserStackVersion: async (versionId) =>
      userStackVersions.get(versionId) ?? null,
    findUserStackVersionByIdempotencyKey: async (userId, idempotencyKey) =>
      [...userStackVersions.values()].find(
        (version) =>
          version.userId === userId &&
          version.idempotencyKey === idempotencyKey,
      ) ?? null,
    commitUserStackVersion: async (
      input: CommitUserStackVersionInput,
    ): Promise<CommitUserStackVersionOutcome> => {
      const existing = userStacks.get(userStackKey(input.userId, input.name));
      const currentLatest = existing?.latestVersionId ?? null;
      if (currentLatest !== input.expectedLatestVersionId)
        throw new UserStackConflict(
          `Expected latest version ${input.expectedLatestVersionId ?? 'none'}, but it is ${currentLatest ?? 'none'}.`,
        );
      const stack: UserStackRecord = existing ?? {
        stackId: input.ids.stackId,
        userId: input.userId,
        name: input.name,
        latestVersionId: null,
        createdAt: input.now,
      };
      const previousNumber = currentLatest
        ? (userStackVersions.get(currentLatest)?.versionNumber ?? 0)
        : 0;
      const version: UserStackVersionRecord = {
        versionId: input.ids.versionId,
        stackId: stack.stackId,
        userId: input.userId,
        versionNumber: previousNumber + 1,
        digest: input.digest,
        bundle: input.bundle,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        createdAt: input.now,
      };
      userStackVersions.set(version.versionId, version);
      const updated: UserStackRecord = {
        ...stack,
        latestVersionId: version.versionId,
      };
      userStacks.set(userStackKey(input.userId, input.name), updated);
      return { stack: updated, version, createdNew: !existing };
    },
    renameUserStack: async (userId, stackId, name) => {
      const existing = [...userStacks.values()].find(
        (stack) => stack.userId === userId && stack.stackId === stackId,
      );
      if (!existing) return null;
      if (existing.name === name) return existing;
      const collision = userStacks.get(userStackKey(userId, name));
      if (collision)
        throw new UserStackNameConflict(
          `A Stack named "${name}" already exists.`,
        );
      userStacks.delete(userStackKey(userId, existing.name));
      const renamed: UserStackRecord = { ...existing, name };
      userStacks.set(userStackKey(userId, name), renamed);
      return renamed;
    },
  };
};

/**
 * In-memory remote Memory backend factory for tests. Reuses the domain's
 * content-addressed in-memory store; `memoryBackendFor(userId)` yields a per-user
 * `RemoteMemoryBackend`, matching how a Supabase-backed factory would behave.
 */
export const createInMemoryMemoryBackends = (): {
  store: InMemoryRemoteMemoryStore;
  memoryBackendFor: (userId: string) => RemoteMemoryBackend;
} => {
  const store = new InMemoryRemoteMemoryStore();
  return {
    store,
    memoryBackendFor: (userId: string) =>
      inMemoryRemoteMemoryBackend(store, userId),
  };
};

// Structurally separate key namespace from `blobs` (content-hash-keyed snapshots) — a
// review-artifact payload is keyed by its own globally-unique artifact id, so it can never
// collide with a snapshot's content hash even if the bytes happened to match.
const reviewPayloadKey = (userId: string, reviewArtifactId: string) =>
  `review ${userId} ${reviewArtifactId}`;

export const createInMemoryBlobStore = (): CloudBlobStore & {
  blobs: Map<string, Uint8Array>;
} => {
  const pending = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  const reviewPayloads = new Map<string, Uint8Array>();
  return {
    blobs,
    putPending: async (ticket, bytes) => {
      pending.set(ticket, bytes);
    },
    getPending: async (ticket) => pending.get(ticket) ?? null,
    deletePending: async (ticket) => {
      pending.delete(ticket);
    },
    put: async (userId, contentHash, bytes) => {
      blobs.set(key(userId, contentHash), bytes);
    },
    get: async (userId, contentHash) =>
      blobs.get(key(userId, contentHash)) ?? null,
    has: async (userId, contentHash) => blobs.has(key(userId, contentHash)),
    putReviewPayload: async (userId, reviewArtifactId, bytes) => {
      reviewPayloads.set(reviewPayloadKey(userId, reviewArtifactId), bytes);
    },
    getReviewPayload: async (userId, reviewArtifactId) =>
      reviewPayloads.get(reviewPayloadKey(userId, reviewArtifactId)) ?? null,
    deleteReviewPayload: async (userId, reviewArtifactId) => {
      reviewPayloads.delete(reviewPayloadKey(userId, reviewArtifactId));
    },
  };
};

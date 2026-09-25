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
} from './repository.js';

const key = (userId: string, value: string) => `${userId} ${value}`;

export const createInMemoryRepository = (): CloudRepository &
  PublicStackRepository & {
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
  const handlesByUser = new Map<string, PublicHandleRecord>();
  const handleOwners = new Map<string, string>();
  const publicStacks = new Map<string, PublicStackRecord>();
  const publicVersions = new Map<string, PublicStackVersionRecord>();

  const envKey = (userId: string, name: string) => key(userId, name);
  const stackKey = (ownerUserId: string, slug: string) =>
    key(ownerUserId, slug);

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
      const existing = machines.get(key(record.userId, record.machineId));
      machines.set(key(record.userId, record.machineId), {
        ...record,
        firstSeenAt: existing?.firstSeenAt ?? record.firstSeenAt,
      });
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

export const createInMemoryBlobStore = (): CloudBlobStore & {
  blobs: Map<string, Uint8Array>;
} => {
  const pending = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
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
  };
};

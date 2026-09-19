import type { CloudEnvironmentBundle } from '@stack/spec';

export type CloudProfile = {
  userId: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type CliAuthSessionStatus =
  'pending' | 'approved' | 'consumed' | 'expired' | 'denied';

export type CliAuthSessionRecord = {
  sessionId: string;
  userCode: string;
  deviceSecretHash: string;
  status: CliAuthSessionStatus;
  userId?: string;
  machineId?: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
};

export type CliTokenRecord = {
  tokenId: string;
  userId: string;
  tokenHash: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type CloudEnvironmentRecord = {
  environmentId: string;
  userId: string;
  name: string;
  latestVersionId: string | null;
  createdAt: string;
};

export type CloudEnvironmentVersionRecord = {
  versionId: string;
  environmentId: string;
  userId: string;
  versionNumber: number;
  digest: string;
  bundle: CloudEnvironmentBundle;
  machineId?: string;
  idempotencyKey?: string;
  createdAt: string;
};

export type CloudSnapshotRecord = {
  userId: string;
  contentHash: string;
  archiveHash: string;
  byteSize: number;
  createdAt: string;
};

export type CloudMachineRecord = {
  userId: string;
  machineId: string;
  platform?: string;
  arch?: string;
  firstSeenAt: string;
  lastSyncedAt?: string;
};

export type CommitVersionInput = {
  userId: string;
  name: string;
  bundle: CloudEnvironmentBundle;
  digest: string;
  expectedLatestVersionId: string | null;
  machineId?: string;
  idempotencyKey?: string;
  ids: { environmentId: string; versionId: string };
  now: string;
};

export type CommitVersionOutcome = {
  environment: CloudEnvironmentRecord;
  version: CloudEnvironmentVersionRecord;
  createdNew: boolean;
};

/**
 * Persistence boundary. Implementations must keep {@link commitEnvironmentVersion}
 * atomic: the optimistic latest-version check, the immutable version insert, and
 * the latest pointer update happen as one indivisible operation.
 */
export interface CloudRepository {
  getProfile(userId: string): Promise<CloudProfile | null>;
  upsertProfile(profile: CloudProfile): Promise<void>;

  createAuthSession(record: CliAuthSessionRecord): Promise<void>;
  findAuthSessionByDeviceHash(
    deviceSecretHash: string,
  ): Promise<CliAuthSessionRecord | null>;
  findAuthSessionByUserCode(
    userCode: string,
  ): Promise<CliAuthSessionRecord | null>;
  updateAuthSession(
    sessionId: string,
    patch: Partial<CliAuthSessionRecord>,
  ): Promise<void>;

  createToken(record: CliTokenRecord): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<CliTokenRecord | null>;
  updateToken(tokenId: string, patch: Partial<CliTokenRecord>): Promise<void>;

  getEnvironmentByName(
    userId: string,
    name: string,
  ): Promise<CloudEnvironmentRecord | null>;
  getEnvironmentVersion(
    versionId: string,
  ): Promise<CloudEnvironmentVersionRecord | null>;
  findVersionByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<CloudEnvironmentVersionRecord | null>;
  /** Atomic optimistic commit. Throws {@link RemoteConflict} on version mismatch. */
  commitEnvironmentVersion(
    input: CommitVersionInput,
  ): Promise<CommitVersionOutcome>;

  hasSnapshot(userId: string, contentHash: string): Promise<boolean>;
  getSnapshot(
    userId: string,
    contentHash: string,
  ): Promise<CloudSnapshotRecord | null>;
  putSnapshot(record: CloudSnapshotRecord): Promise<void>;

  upsertMachine(record: CloudMachineRecord): Promise<void>;
}

/** Thrown by {@link CloudRepository.commitEnvironmentVersion} on a stale base. */
export class RemoteConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteConflict';
  }
}

export interface CloudBlobStore {
  putPending(ticket: string, bytes: Uint8Array): Promise<void>;
  getPending(ticket: string): Promise<Uint8Array | null>;
  deletePending(ticket: string): Promise<void>;
  put(userId: string, contentHash: string, bytes: Uint8Array): Promise<void>;
  get(userId: string, contentHash: string): Promise<Uint8Array | null>;
  has(userId: string, contentHash: string): Promise<boolean>;
}

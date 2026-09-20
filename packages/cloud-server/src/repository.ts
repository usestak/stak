import type { CloudEnvironmentBundle, PublicStackBundle } from '@stack/spec';

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

/* -------------------------------------------------------------------------- */
/* Public Stack publishing                                                    */
/* -------------------------------------------------------------------------- */

export type PublicHandleRecord = {
  userId: string;
  handle: string;
  createdAt: string;
};

export type PublicStackRecord = {
  stackId: string;
  ownerUserId: string;
  ownerHandle: string;
  slug: string;
  displayName: string;
  description: string;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicStackVersionRecord = {
  versionId: string;
  stackId: string;
  ownerUserId: string;
  versionNumber: number;
  versionHash: string;
  digest: string;
  bundle: PublicStackBundle;
  displayName: string;
  description: string;
  idempotencyKey?: string;
  createdAt: string;
};

export type CommitPublicVersionInput = {
  ownerUserId: string;
  ownerHandle: string;
  slug: string;
  displayName: string;
  description: string;
  bundle: PublicStackBundle;
  digest: string;
  versionHash: string;
  expectedLatestVersionId: string | null;
  idempotencyKey?: string;
  ids: { stackId: string; versionId: string };
  now: string;
};
export type CommitPublicVersionOutcome = {
  stack: PublicStackRecord;
  version: PublicStackVersionRecord;
  createdNew: boolean;
};

export class PublicStackConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicStackConflict';
  }
}

export interface PublicStackRepository {
  getHandleForUser(userId: string): Promise<string | null>;
  findHandleOwner(handle: string): Promise<string | null>;
  reserveHandle(record: PublicHandleRecord): Promise<void>;

  getProfileByHandle(handle: string): Promise<CloudProfile | null>;
  getPublicStackByHandleSlug(
    handle: string,
    slug: string,
  ): Promise<PublicStackRecord | null>;
  getPublicStackByOwner(
    ownerUserId: string,
    slug: string,
  ): Promise<PublicStackRecord | null>;
  getPublicStackVersionById(
    versionId: string,
  ): Promise<PublicStackVersionRecord | null>;
  getPublicStackVersionByNumber(
    stackId: string,
    versionNumber: number,
  ): Promise<PublicStackVersionRecord | null>;
  findPublicVersionByIdempotencyKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<PublicStackVersionRecord | null>;
  /** Atomic create-or-append with optimistic latest-version protection. */
  commitPublicStackVersion(
    input: CommitPublicVersionInput,
  ): Promise<CommitPublicVersionOutcome>;
  listPublicStacksByHandle(handle: string): Promise<PublicStackRecord[]>;
}

export interface CloudBlobStore {
  putPending(ticket: string, bytes: Uint8Array): Promise<void>;
  getPending(ticket: string): Promise<Uint8Array | null>;
  deletePending(ticket: string): Promise<void>;
  put(userId: string, contentHash: string, bytes: Uint8Array): Promise<void>;
  get(userId: string, contentHash: string): Promise<Uint8Array | null>;
  has(userId: string, contentHash: string): Promise<boolean>;
}

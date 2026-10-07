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
  // Phase P3: the machine this token authenticates, so a machine revoke can target its tokens.
  machineId?: string;
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
  // Phase P1 check-in fields (all optional for backward compatibility).
  name?: string;
  agentsDetected?: string[];
  lastCheckinAt?: string;
  memoryBackedUp?: boolean;
  // Phase P3: when the machine's authorization was revoked. The row is retained as a revoked
  // record (audit); revocation never deletes Skills/Projects/Memory.
  revokedAt?: string;
};

/**
 * Phase P3: account-side project registry row. Carries only the opaque Project ID, lifecycle
 * and an optional safe display name — NEVER a path, machine-local binding, or identity claim
 * that could leak a filesystem location. Synced from the CLI; owner-scoped.
 */
export type CloudProjectRecord = {
  userId: string;
  projectId: string;
  lifecycle: 'active' | 'archived';
  name?: string;
  updatedAt: string;
};

/** Phase P1: a machine's installed version of one skill, reported at check-in. */
export type MachineSkillVersionRecord = {
  skillId: string;
  installedVersion: string;
};

/** Phase P1: whether a project is present on a machine. PRESENCE ONLY — never a path. */
export type MachineProjectPresenceRecord = {
  projectId: string;
  present: boolean;
};

export type ReviewArtifactFileRecord = {
  relativePath: string;
  kind: 'added' | 'modified' | 'removed';
  binary: boolean;
  before?: { byteSize: number; hash: string };
  after?: { byteSize: number; hash: string };
};

export type SkillReviewCheckRecord = {
  userId: string;
  skillId: string;
  approvedContentHash: string;
  sourceCheckState:
    'no-update' | 'update-available' | 'cannot-check' | 'check-failed';
  checkedAt: string;
  // Reserved for intrinsic, zero-network-I/O facts about the Skill's own restoration record.
  // A failed NETWORK operation (DNS/timeout/host-down/auth) is `check-failed`, never this.
  cannotCheckReason?: 'local' | 'dirty' | 'ambiguous' | 'pinned';
  checkFailedReason?: string;
  candidateRevision?: string;
  candidateContentHash?: string;
  // A real update was found but Cloud holds no reviewable artifact for it (e.g. it exceeds
  // V0 review bounds) — a REVIEW CAPABILITY fact, distinct from the SOURCE fact above. Only
  // valid alongside sourceCheckState 'update-available', and mutually exclusive with
  // reviewArtifactId (never both at once).
  reviewUnavailableReason?: 'exceeds-review-bounds';
  reviewArtifactId?: string;
  artifactPayloadHash?: string;
  diffFiles?: ReviewArtifactFileRecord[];
};

/** Phase P1: the full check-in a machine reports. Carries no paths and no Memory content. */
export type RecordCheckinInput = {
  userId: string;
  machineId: string;
  name?: string;
  platform?: string;
  arch?: string;
  agentsDetected?: string[];
  memoryBackedUp: boolean;
  skills: MachineSkillVersionRecord[];
  projects: MachineProjectPresenceRecord[];
  now: string;
};

/** Phase P1: a machine's stored read model (machine + its reported skills/presence). */
export type MachineStateRecord = CloudMachineRecord & {
  skills: MachineSkillVersionRecord[];
  projects: MachineProjectPresenceRecord[];
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

  /**
   * Phase P1: record a machine's check-in — upsert the machine row (name, OS,
   * agents, last check-in, memory-backed-up) and REPLACE its skill versions and
   * project presence atomically. Never stores a filesystem path.
   */
  recordCheckin(input: RecordCheckinInput): Promise<void>;
  /** Phase P1: all machines for a user with their reported skill versions + presence. */
  listMachineStates(userId: string): Promise<MachineStateRecord[]>;

  /* ----------------------------- Phase P3 ----------------------------- */

  /** All immutable environment versions for one env, newest first (history + activity). */
  listEnvironmentVersions(
    userId: string,
    name: string,
  ): Promise<CloudEnvironmentVersionRecord[]>;

  /**
   * Revoke a machine the user owns: mark the machine row revoked and revoke every CLI token
   * bound to it, atomically. Never deletes Skills/Projects/Memory. Returns the machine id when
   * it belonged to the user, or null when no such machine exists for them.
   */
  revokeMachine(
    userId: string,
    machineId: string,
    now: string,
  ): Promise<{ machineId: string; revokedTokens: number } | null>;

  /** Owner-scoped cloud project registry (lifecycle + safe identity; never paths). */
  listProjects(userId: string): Promise<CloudProjectRecord[]>;
  /**
   * DISCOVERY sync: ensure each Project exists with its safe display name. It NEVER changes an
   * existing row's lifecycle (that is explicit account-side intent); a newly-created row
   * defaults to `active`. So a stale local machine can never unarchive a web-archived Project.
   */
  syncProjects(
    userId: string,
    projects: { projectId: string; name?: string }[],
    now: string,
  ): Promise<void>;
  /** Bind a token to its machine only if unbound (migration-on-first-authenticated-use). */
  bindTokenMachine(tokenId: string, machineId: string): Promise<boolean>;
  /** Explicit account-side lifecycle change; returns the row, or null when not owned/found. */
  setProjectLifecycle(
    userId: string,
    projectId: string,
    lifecycle: 'active' | 'archived',
    now: string,
  ): Promise<CloudProjectRecord | null>;

  /* ----------------------------- Phase P5a ----------------------------- */

  /** Latest-only Skill source-check result (P5a §5a). Null when never checked. */
  getSkillReviewCheck(
    userId: string,
    skillId: string,
  ): Promise<SkillReviewCheckRecord | null>;
  /** Upsert, replacing any existing row for this (userId, skillId) — latest-only. */
  putSkillReviewCheck(record: SkillReviewCheckRecord): Promise<void>;
  deleteSkillReviewCheck(userId: string, skillId: string): Promise<void>;
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
  /**
   * Review-artifact payload storage, keyed by the artifact's own id — deliberately NOT the
   * same content-hash-keyed namespace `put`/`get` use for Memory snapshots. A freshly-minted
   * reviewArtifactId is globally unique, so this key can never collide with a snapshot or
   * with another artifact, which makes deletion on supersession unambiguous by construction.
   * Cloud still verifies the bytes against `artifactPayloadHash` at upload/read time — this
   * key is for storage addressing only, never for integrity.
   */
  putReviewPayload(
    userId: string,
    reviewArtifactId: string,
    bytes: Uint8Array,
  ): Promise<void>;
  getReviewPayload(
    userId: string,
    reviewArtifactId: string,
  ): Promise<Uint8Array | null>;
  /** Idempotent: deleting an already-deleted/never-existed artifact id never throws. */
  deleteReviewPayload(userId: string, reviewArtifactId: string): Promise<void>;
}

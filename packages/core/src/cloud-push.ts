import { randomUUID } from 'node:crypto';

import type {
  CloudEnvironmentBundle,
  GetEnvironmentResponse,
} from '@stack/spec';
import {
  CloudUnauthorizedError,
  CloudVersionCommitFailedError,
  LocalEnvironmentConflictError,
  RemoteEnvironmentConflictError,
  SnapshotUploadFailedError,
  type CloudClient,
} from '@stack/cloud-client';
import { mapWithConcurrency } from '@stack/shared';
import { packStoreObject, type SkillArchive } from '@stack/store';

import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import { loadMainEnvironment } from './state.js';
import {
  readEnvironmentSyncState,
  writeEnvironmentSyncState,
} from './sync-metadata.js';

const DEFAULT_MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
/** Snapshot existence checks / uploads in flight at once. Each is a full Cloud round trip. */
const SNAPSHOT_CONCURRENCY = 6;
/**
 * Reuse a plan-time upload ticket in apply only while it is younger than this. Cloud signs
 * upload tickets with a 10-minute TTL (checked by both upload and finalize), so a ticket
 * reused at this age still has >= 5 minutes left for the upload itself. Anything older is
 * re-prepared right before upload; an upload/finalize that still hits an expired ticket
 * (slow link, clock skew) re-prepares once and retries — see `uploadPending`.
 */
const UPLOAD_TICKET_REUSE_MS = 5 * 60 * 1000;

export type PushConflict = {
  kind: 'remote-newer' | 'unsynced-remote';
  message: string;
  localBaseVersionId: string | null;
  remoteVersionNumber: number | null;
};

export type PushPlan = {
  environment: 'main';
  machineId: string;
  bundle: CloudEnvironmentBundle;
  digest: string;
  remoteExists: boolean;
  remoteVersionNumber: number | null;
  remoteDigest: string | null;
  expectedLatestVersionId: string | null;
  noop: boolean;
  conflict: PushConflict | null;
  desiredSkills: number;
  stackLayers: number;
  references: number;
  snapshotsAlready: number;
  snapshotsToUpload: string[];
  /** In-memory packed archives to upload; not serialized to JSON output. */
  pendingUploads: PendingUpload[];
};

export type PendingUpload = {
  contentHash: string;
  archive: SkillArchive;
  /** Ticket issued while planning, reused by apply if still fresh (saves a round trip). */
  uploadTicket?: string;
  ticketIssuedAt?: number;
};

export type PreparePushOptions = {
  stackHome: string;
  client: Pick<CloudClient, 'getEnvironment' | 'prepareSnapshot'>;
  maxSnapshotBytes?: number;
  nowMs?: () => number;
};

export const preparePush = async (
  options: PreparePushOptions,
): Promise<PushPlan> => {
  const state = await loadMainEnvironment({ stackHome: options.stackHome });
  const bundle = await buildCloudEnvironmentBundle({
    stackHome: options.stackHome,
  });
  const sync = await readEnvironmentSyncState({
    stackHome: options.stackHome,
    machineId: state.machine.machineId,
    environment: 'main',
  });
  const remote: GetEnvironmentResponse | null =
    await options.client.getEnvironment('main');

  let conflict: PushConflict | null = null;
  let noop = false;
  let expectedLatestVersionId: string | null = null;

  if (!remote || !remote.latest) {
    expectedLatestVersionId = null;
  } else if (!sync) {
    conflict = {
      kind: 'unsynced-remote',
      message:
        'A cloud main already exists, but this local main has never synced with it. Stack will not overwrite either Environment automatically.',
      localBaseVersionId: null,
      remoteVersionNumber: remote.latest.version.versionNumber,
    };
  } else if (remote.latest.version.versionId !== sync.lastSyncedVersionId) {
    conflict = {
      kind: 'remote-newer',
      message:
        'Cloud main changed since this Machine last synced. Pull the newer Environment before pushing again.',
      localBaseVersionId: sync.lastSyncedVersionId,
      remoteVersionNumber: remote.latest.version.versionNumber,
    };
  } else if (remote.latest.version.digest === bundle.digest) {
    noop = true;
    expectedLatestVersionId = remote.latest.version.versionId;
  } else {
    expectedLatestVersionId = remote.latest.version.versionId;
  }

  const maxBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const nowMs = options.nowMs ?? Date.now;
  const pendingUploads: PendingUpload[] = [];
  let snapshotsAlready = 0;
  if (!conflict && !noop) {
    // Content this Machine's previous push confirmed is in Cloud needs no re-check
    // (snapshots are never deleted). Deliberately NOT the remote bundle's own requirement
    // list: legacy bundles derive it from every Skill, including Git-backed ones older
    // CLIs never uploaded. Only new content costs a round trip, and those run concurrently.
    const known = new Set(
      sync?.lastSyncedVersionId === remote?.latest?.version.versionId
        ? (sync?.confirmedContentHashes ?? [])
        : [],
    );
    const unknown = bundle.contentUploadRequirements.filter(
      (requirement) => !known.has(requirement.contentHash),
    );
    snapshotsAlready +=
      bundle.contentUploadRequirements.length - unknown.length;
    const checked = await mapWithConcurrency(
      unknown,
      SNAPSHOT_CONCURRENCY,
      async (requirement): Promise<PendingUpload | null> => {
        const archive = await packStoreObject({
          stackHome: options.stackHome,
          contentHash: requirement.contentHash,
        });
        if (archive.byteSize > maxBytes)
          throw new SnapshotUploadFailedError(
            `Snapshot ${requirement.contentHash} is ${archive.byteSize} bytes, exceeding the ${maxBytes}-byte limit.`,
          );
        const prepared = await options.client.prepareSnapshot({
          contentHash: requirement.contentHash,
          archiveHash: archive.archiveHash,
          byteSize: archive.byteSize,
        });
        if (prepared.status === 'exists') return null;
        return {
          contentHash: requirement.contentHash,
          archive,
          uploadTicket: prepared.uploadTicket,
          ticketIssuedAt: nowMs(),
        };
      },
    );
    for (const pending of checked)
      if (pending) pendingUploads.push(pending);
      else snapshotsAlready += 1;
  }

  return {
    environment: 'main',
    machineId: state.machine.machineId,
    bundle,
    digest: bundle.digest,
    remoteExists: Boolean(remote),
    remoteVersionNumber: remote?.latest?.version.versionNumber ?? null,
    remoteDigest: remote?.latest?.version.digest ?? null,
    expectedLatestVersionId,
    noop,
    conflict,
    desiredSkills: Object.keys(bundle.resolved.skills).length,
    stackLayers: bundle.importedStackVersions.length,
    references: Object.values(bundle.resolved.skills).filter(
      (skill) => skill.restoration.strategy === 'reference',
    ).length,
    snapshotsAlready,
    snapshotsToUpload: pendingUploads.map((item) => item.contentHash),
    pendingUploads,
  };
};

export type ApplyPushResult = {
  environment: 'main';
  versionId: string;
  versionNumber: number;
  digest: string;
  createdNew: boolean;
  uploaded: number;
};

export type ApplyPushOptions = {
  stackHome: string;
  plan: PushPlan;
  client: Pick<
    CloudClient,
    | 'prepareSnapshot'
    | 'uploadSnapshot'
    | 'finalizeSnapshot'
    | 'commitEnvironmentVersion'
  >;
  now?: () => Date;
  nowMs?: () => number;
  idempotencyKey?: string;
};

export const applyPush = async (
  options: ApplyPushOptions,
): Promise<ApplyPushResult> => {
  const { plan } = options;
  if (plan.conflict)
    throw plan.conflict.kind === 'remote-newer'
      ? new RemoteEnvironmentConflictError(plan.conflict.message)
      : new LocalEnvironmentConflictError(plan.conflict.message);
  if (plan.noop)
    throw new CloudVersionCommitFailedError(
      'main is already up to date; nothing to push.',
    );

  const nowMs = options.nowMs ?? Date.now;
  const { client } = options;

  /** A fresh upload ticket, or null if Cloud already has the content (e.g. another
   *  Machine uploaded it since planning). */
  const prepareTicket = async (
    pending: PendingUpload,
  ): Promise<string | null> => {
    const prepared = await client.prepareSnapshot({
      contentHash: pending.contentHash,
      archiveHash: pending.archive.archiveHash,
      byteSize: pending.archive.byteSize,
    });
    return prepared.status === 'upload' ? prepared.uploadTicket : null;
  };
  const uploadWithTicket = async (
    pending: PendingUpload,
    uploadTicket: string,
  ): Promise<void> => {
    await client.uploadSnapshot(uploadTicket, pending.archive.bytes);
    await client.finalizeSnapshot({
      contentHash: pending.contentHash,
      archiveHash: pending.archive.archiveHash,
      byteSize: pending.archive.byteSize,
      uploadTicket,
    });
  };
  /** Returns true if this call uploaded the content, false if Cloud already had it. */
  const uploadPending = async (pending: PendingUpload): Promise<boolean> => {
    // Checked here, right before the upload starts (not when the plan was made), so time
    // spent at the confirmation prompt or queued behind other uploads counts.
    const reusable =
      pending.uploadTicket !== undefined &&
      pending.ticketIssuedAt !== undefined &&
      nowMs() - pending.ticketIssuedAt < UPLOAD_TICKET_REUSE_MS;
    // A stale plan re-checks, which also catches content uploaded in the meantime.
    const ticket = reusable
      ? (pending.uploadTicket as string)
      : await prepareTicket(pending);
    if (ticket === null) return false;
    try {
      await uploadWithTicket(pending, ticket);
      return true;
    } catch (error) {
      // Cloud answers an expired (or otherwise unusable) ticket with cloud-unauthorized.
      // Get a new ticket and retry exactly once; a second failure (or a genuine
      // authorization problem, which prepare will also hit) propagates unchanged.
      if (!(error instanceof CloudUnauthorizedError)) throw error;
      const retryTicket = await prepareTicket(pending);
      if (retryTicket === null) return false;
      await uploadWithTicket(pending, retryTicket);
      return true;
    }
  };

  const results = await mapWithConcurrency(
    plan.pendingUploads,
    SNAPSHOT_CONCURRENCY,
    uploadPending,
  );
  const uploaded = results.filter(Boolean).length;

  const committed = await options.client.commitEnvironmentVersion('main', {
    bundle: plan.bundle,
    expectedLatestVersionId: plan.expectedLatestVersionId,
    machineId: plan.machineId,
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
  });

  await writeEnvironmentSyncState({
    stackHome: options.stackHome,
    machineId: plan.machineId,
    environment: 'main',
    state: {
      remoteEnvironmentId: committed.environmentId,
      lastSyncedVersionId: committed.version.versionId,
      lastSyncedDigest: committed.version.digest,
      syncedAt: (options.now ?? (() => new Date()))().toISOString(),
      // Every requirement is now confirmed in Cloud: checked at plan time, carried over
      // from the previous push's confirmation, or uploaded above.
      confirmedContentHashes: plan.bundle.contentUploadRequirements.map(
        (requirement) => requirement.contentHash,
      ),
    },
  });

  return {
    environment: 'main',
    versionId: committed.version.versionId,
    versionNumber: committed.version.versionNumber,
    digest: committed.version.digest,
    createdNew: committed.createdNew,
    uploaded,
  };
};

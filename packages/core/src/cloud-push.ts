import { randomUUID } from 'node:crypto';

import type {
  CloudEnvironmentBundle,
  GetEnvironmentResponse,
} from '@stack/spec';
import {
  CloudVersionCommitFailedError,
  LocalEnvironmentConflictError,
  RemoteEnvironmentConflictError,
  SnapshotUploadFailedError,
  type CloudClient,
} from '@stack/cloud-client';
import { packStoreObject, type SkillArchive } from '@stack/store';

import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import { loadMainEnvironment } from './state.js';
import {
  readEnvironmentSyncState,
  writeEnvironmentSyncState,
} from './sync-metadata.js';

const DEFAULT_MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;

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
  pendingUploads: Array<{ contentHash: string; archive: SkillArchive }>;
};

export type PreparePushOptions = {
  stackHome: string;
  client: Pick<CloudClient, 'getEnvironment' | 'prepareSnapshot'>;
  maxSnapshotBytes?: number;
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
  const pendingUploads: Array<{ contentHash: string; archive: SkillArchive }> =
    [];
  let snapshotsAlready = 0;
  if (!conflict && !noop)
    for (const requirement of bundle.contentUploadRequirements) {
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
      if (prepared.status === 'exists') snapshotsAlready += 1;
      else
        pendingUploads.push({ contentHash: requirement.contentHash, archive });
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

  let uploaded = 0;
  for (const pending of plan.pendingUploads) {
    const prepared = await options.client.prepareSnapshot({
      contentHash: pending.contentHash,
      archiveHash: pending.archive.archiveHash,
      byteSize: pending.archive.byteSize,
    });
    if (prepared.status === 'upload') {
      await options.client.uploadSnapshot(
        prepared.uploadTicket,
        pending.archive.bytes,
      );
      await options.client.finalizeSnapshot({
        contentHash: pending.contentHash,
        archiveHash: pending.archive.archiveHash,
        byteSize: pending.archive.byteSize,
        uploadTicket: prepared.uploadTicket,
      });
      uploaded += 1;
    }
  }

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

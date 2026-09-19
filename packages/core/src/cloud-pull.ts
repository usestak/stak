import type {
  CloudEnvironmentBundle,
  GetEnvironmentResponse,
} from '@stack/spec';
import {
  LocalEnvironmentConflictError,
  RemoteEnvironmentNotFoundError,
  type CloudClient,
} from '@stack/cloud-client';

import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import {
  applyCloudRestore,
  planCloudRestore,
  type CloudRestorePlan,
  type CloudRestoreResult,
} from './cloud-restore.js';
import type { GitExecutor } from './git-reference.js';
import { StackStateError, loadMainEnvironment } from './state.js';
import {
  readEnvironmentSyncState,
  writeEnvironmentSyncState,
} from './sync-metadata.js';

export type PullConflict = {
  kind: 'unsynced-local' | 'local-changes';
  message: string;
};

export type PullPlan = {
  environment: 'main';
  mode: 'create' | 'replace' | 'noop' | 'conflict';
  conflict: PullConflict | null;
  remoteExists: boolean;
  remoteVersionNumber: number | null;
  remoteDigest: string | null;
  localExists: boolean;
  localDigest: string | null;
  localSyncedVersionId: string | null;
  restore: CloudRestorePlan | null;
  bundle: CloudEnvironmentBundle | null;
  remoteEnvironmentId: string | null;
  remoteVersionId: string | null;
};

export type PreparePullOptions = {
  stackHome: string;
  client: Pick<CloudClient, 'getEnvironment'>;
};

export const preparePull = async (
  options: PreparePullOptions,
): Promise<PullPlan> => {
  const remote: GetEnvironmentResponse | null =
    await options.client.getEnvironment('main');
  if (!remote || !remote.latest)
    throw new RemoteEnvironmentNotFoundError(
      'There is no cloud main to pull yet.',
    );

  let localExists = true;
  let localMachineId: string | undefined;
  try {
    const localState = await loadMainEnvironment({
      stackHome: options.stackHome,
    });
    localMachineId = localState.machine.machineId;
  } catch (error) {
    if (
      error instanceof StackStateError &&
      error.code === 'environment-not-found'
    )
      localExists = false;
    else throw error;
  }

  const sync =
    localExists && localMachineId
      ? await readEnvironmentSyncState({
          stackHome: options.stackHome,
          machineId: localMachineId,
          environment: 'main',
        })
      : undefined;
  const localDigest = localExists
    ? (await buildCloudEnvironmentBundle({ stackHome: options.stackHome }))
        .digest
    : null;

  let mode: PullPlan['mode'] = 'create';
  let conflict: PullConflict | null = null;

  if (localExists) {
    if (!sync) {
      mode = 'conflict';
      conflict = {
        kind: 'unsynced-local',
        message:
          'A local main exists but has never synced with this cloud main. Stack will not overwrite it automatically.',
      };
    } else if (localDigest !== sync.lastSyncedDigest) {
      if (remote.latest.version.digest === localDigest) {
        mode = 'noop';
      } else {
        mode = 'conflict';
        conflict = {
          kind: 'local-changes',
          message:
            'main has local changes that have not been pushed. Stack will not replace them automatically.',
        };
      }
    } else if (
      remote.latest.version.versionId === sync.lastSyncedVersionId &&
      remote.latest.version.digest === localDigest
    ) {
      mode = 'noop';
    } else {
      mode = 'replace';
    }
  }

  const restore =
    mode === 'create' || mode === 'replace'
      ? await planCloudRestore({
          stackHome: options.stackHome,
          bundle: remote.latest.bundle,
        })
      : null;

  return {
    environment: 'main',
    mode,
    conflict,
    remoteExists: true,
    remoteVersionNumber: remote.latest.version.versionNumber,
    remoteDigest: remote.latest.version.digest,
    localExists,
    localDigest,
    localSyncedVersionId: sync?.lastSyncedVersionId ?? null,
    restore,
    bundle:
      mode === 'create' || mode === 'replace' ? remote.latest.bundle : null,
    remoteEnvironmentId: remote.environmentId,
    remoteVersionId: remote.latest.version.versionId,
  };
};

export type ApplyPullResult =
  | { environment: 'main'; status: 'noop' }
  | ({ environment: 'main'; status: 'restored' } & CloudRestoreResult);

export type ApplyPullOptions = {
  stackHome: string;
  plan: PullPlan;
  client: Pick<CloudClient, 'downloadSnapshot'>;
  gitExecutor?: GitExecutor;
  now?: () => Date;
  idFactory?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
};

export const applyPull = async (
  options: ApplyPullOptions,
): Promise<ApplyPullResult> => {
  const { plan } = options;
  if (plan.conflict)
    throw new LocalEnvironmentConflictError(plan.conflict.message);
  if (plan.mode === 'noop') return { environment: 'main', status: 'noop' };
  if (!plan.bundle || !plan.remoteEnvironmentId || !plan.remoteVersionId)
    throw new LocalEnvironmentConflictError(
      'Pull plan is missing remote Environment details.',
    );

  const result = await applyCloudRestore({
    stackHome: options.stackHome,
    bundle: plan.bundle,
    client: options.client,
    ...(options.gitExecutor ? { gitExecutor: options.gitExecutor } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
  });

  const { getOrCreateMachineIdentity } = await import('./state.js');
  const machine = await getOrCreateMachineIdentity({
    stackHome: options.stackHome,
  });
  await writeEnvironmentSyncState({
    stackHome: options.stackHome,
    machineId: machine.machineId,
    environment: 'main',
    state: {
      remoteEnvironmentId: plan.remoteEnvironmentId,
      lastSyncedVersionId: plan.remoteVersionId,
      lastSyncedDigest: plan.remoteDigest ?? result.digest,
      syncedAt: (options.now ?? (() => new Date()))().toISOString(),
    },
  });

  return { ...result, environment: 'main', status: 'restored' };
};

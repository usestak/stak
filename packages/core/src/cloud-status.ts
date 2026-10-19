import type { CloudClient } from '@stack/cloud-client';

import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import { loadMainEnvironment } from './state.js';
import { readEnvironmentSyncState } from './sync-metadata.js';

/**
 * `main`'s sync state relative to STAK Cloud, from the same cheap metadata call
 * (`client.getEnvironment`) `preparePush`/`preparePull` already use to detect conflicts —
 * no snapshot/blob download, so this is safe for `stak status` to call on every run.
 */
export type EnvironmentCloudSyncState =
  | { status: 'no-remote' }
  | { status: 'up-to-date' }
  | { status: 'ahead' }
  | { status: 'behind'; remoteVersionNumber: number }
  | { status: 'diverged' };

export type CheckEnvironmentCloudSyncOptions = {
  stackHome: string;
  client: Pick<CloudClient, 'getEnvironment'>;
};

export const checkEnvironmentCloudSync = async (
  options: CheckEnvironmentCloudSyncOptions,
): Promise<EnvironmentCloudSyncState> => {
  const state = await loadMainEnvironment({ stackHome: options.stackHome });
  const bundle = await buildCloudEnvironmentBundle({
    stackHome: options.stackHome,
  });
  const sync = await readEnvironmentSyncState({
    stackHome: options.stackHome,
    machineId: state.machine.machineId,
    environment: 'main',
  });
  const remote = await options.client.getEnvironment('main');
  if (!remote || !remote.latest) return { status: 'no-remote' };

  // This machine has a cloud environment to compare against but has never itself synced
  // with it (e.g. main existed locally before `stak login`, or was created independently
  // on another machine) — never guess which side should win.
  if (!sync) return { status: 'diverged' };

  const remoteChanged = remote.latest.version.versionId !== sync.lastSyncedVersionId;
  const localChanged = bundle.digest !== sync.lastSyncedDigest;
  if (!remoteChanged && !localChanged) return { status: 'up-to-date' };
  if (remoteChanged && !localChanged)
    return {
      status: 'behind',
      remoteVersionNumber: remote.latest.version.versionNumber,
    };
  if (!remoteChanged && localChanged) return { status: 'ahead' };
  return { status: 'diverged' };
};

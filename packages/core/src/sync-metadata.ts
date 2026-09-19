import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { machineSyncStateSchema } from '@stack/spec';
import type { EnvironmentSyncState, MachineSyncState } from '@stack/spec';

const syncStatePath = (stackHome: string, machineId: string) =>
  path.join(stackHome, 'state', 'machines', machineId, 'sync.json');

const empty = (): MachineSyncState => ({ schemaVersion: 1, environments: {} });

export const readMachineSyncState = async (options: {
  stackHome: string;
  machineId: string;
}): Promise<MachineSyncState> => {
  try {
    return machineSyncStateSchema.parse(
      JSON.parse(
        await readFile(
          syncStatePath(options.stackHome, options.machineId),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
};

export const readEnvironmentSyncState = async (options: {
  stackHome: string;
  machineId: string;
  environment: string;
}): Promise<EnvironmentSyncState | undefined> =>
  (await readMachineSyncState(options)).environments[options.environment];

export const writeEnvironmentSyncState = async (options: {
  stackHome: string;
  machineId: string;
  environment: string;
  state: EnvironmentSyncState;
}): Promise<void> => {
  const current = await readMachineSyncState(options);
  const next = machineSyncStateSchema.parse({
    schemaVersion: 1,
    environments: {
      ...current.environments,
      [options.environment]: options.state,
    },
  });
  const file = syncStatePath(options.stackHome, options.machineId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.sync.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

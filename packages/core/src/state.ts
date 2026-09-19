import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  environmentLockSchema,
  environmentManifestSchema,
  machineEnvironmentBaselineSchema,
  machineIdentitySchema,
} from '@stack/spec';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  MachineEnvironmentBaseline,
  MachineIdentity,
} from '@stack/spec';

export class StackStateError extends Error {
  constructor(
    public readonly code:
      | 'environment-exists'
      | 'environment-not-found'
      | 'incomplete-scan'
      | 'invalid-state',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StackStateError';
  }
}

export type ResolveStackHomeOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export const resolveStackHome = (
  options: ResolveStackHomeOptions = {},
): string =>
  path.resolve(
    options.env?.STACK_HOME ??
      process.env.STACK_HOME ??
      path.join(options.homeDir ?? os.homedir(), '.stack'),
  );

type BaseStatePaths = {
  machine: string;
  environmentDirectory: string;
  manifest: string;
  lock: string;
};

export function statePaths(stackHome: string): BaseStatePaths;
export function statePaths(
  stackHome: string,
  machineId: string,
): BaseStatePaths & { baseline: string };
export function statePaths(stackHome: string, machineId?: string) {
  const environmentDirectory = path.join(stackHome, 'environments', 'main');
  return {
    machine: path.join(stackHome, 'machine.json'),
    environmentDirectory,
    manifest: path.join(environmentDirectory, 'environment.yaml'),
    lock: path.join(environmentDirectory, 'stack.lock.json'),
    ...(machineId
      ? {
          baseline: path.join(
            stackHome,
            'state',
            'machines',
            machineId,
            'environments',
            'main.json',
          ),
        }
      : {}),
  };
}

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8')) as unknown;

const atomicWrite = async (file: string, value: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export type GetMachineIdentityOptions = {
  stackHome: string;
  now?: () => Date;
  idFactory?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
};

export const getOrCreateMachineIdentity = async (
  options: GetMachineIdentityOptions,
): Promise<MachineIdentity> => {
  const file = statePaths(options.stackHome).machine;
  try {
    return machineIdentitySchema.parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = machineIdentitySchema.parse({
    schemaVersion: 1,
    machineId: (options.idFactory ?? randomUUID)(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  });
  try {
    await atomicWrite(file, `${JSON.stringify(identity, null, 2)}\n`);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return machineIdentitySchema.parse(await readJson(file));
    throw error;
  }
};

export type LoadedEnvironmentState = {
  machine: MachineIdentity;
  manifest: EnvironmentManifest;
  lock: EnvironmentLock;
  baseline: MachineEnvironmentBaseline;
};

export type LoadMainEnvironmentOptions = { stackHome: string };

export const loadMainEnvironment = async ({
  stackHome,
}: LoadMainEnvironmentOptions): Promise<LoadedEnvironmentState> => {
  try {
    const machine = machineIdentitySchema.parse(
      await readJson(statePaths(stackHome).machine),
    );
    const paths = statePaths(stackHome, machine.machineId);
    const [manifestText, lockValue, baselineValue] = await Promise.all([
      readFile(paths.manifest, 'utf8'),
      readJson(paths.lock),
      readJson(paths.baseline),
    ]);
    const state = {
      machine,
      manifest: environmentManifestSchema.parse(parseYaml(manifestText)),
      lock: environmentLockSchema.parse(lockValue),
      baseline: machineEnvironmentBaselineSchema.parse(baselineValue),
    };
    if (
      state.baseline.machineId !== machine.machineId ||
      state.baseline.environment !== state.manifest.name ||
      state.manifest.skills.some(
        (entry) =>
          state.lock.skills[entry.id] === undefined ||
          state.baseline.skills[entry.id] === undefined,
      )
    )
      throw new StackStateError(
        'invalid-state',
        'Machine baseline does not match the active Environment.',
      );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new StackStateError(
        'environment-not-found',
        'main does not exist. Run stack init first.',
        { cause: error },
      );
    throw error;
  }
};

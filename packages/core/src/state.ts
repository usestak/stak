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

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Reject state written by a newer, unsupported Stack schema version. */
const assertSupportedSchema = (
  value: unknown,
  label: string,
  supported = 1,
): void => {
  if (value && typeof value === 'object' && 'schemaVersion' in value) {
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === 'number' && version > supported)
      throw new StackStateError(
        'invalid-state',
        `${label} was written by a newer version of Stack (schema v${version}); upgrade Stack. No changes were made.`,
      );
  }
};

/** Parse persisted state, converting corruption into a clear typed error. */
const parseState = <T>(
  schema: { parse(value: unknown): T },
  value: unknown,
  label: string,
): T => {
  assertSupportedSchema(value, label);
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof StackStateError) throw error;
    throw new StackStateError(
      'invalid-state',
      `${label} is corrupt or unreadable. Stack made no changes.`,
      { cause: error },
    );
  }
};

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
    return parseState(
      machineIdentitySchema,
      await readJson(file),
      'Machine identity',
    );
  } catch (error) {
    if (error instanceof StackStateError) throw error;
    if (error instanceof SyntaxError)
      throw new StackStateError(
        'invalid-state',
        'Machine identity is corrupt or unreadable. Stack made no changes.',
        { cause: error },
      );
    if (!isNotFound(error)) throw error;
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
    const machine = parseState(
      machineIdentitySchema,
      await readJson(statePaths(stackHome).machine),
      'Machine identity',
    );
    const paths = statePaths(stackHome, machine.machineId);
    const [manifestText, lockValue, baselineValue] = await Promise.all([
      readFile(paths.manifest, 'utf8'),
      readJson(paths.lock),
      readJson(paths.baseline),
    ]);
    const state = {
      machine,
      manifest: parseState(
        environmentManifestSchema,
        parseYaml(manifestText),
        'Environment manifest',
      ),
      lock: parseState(environmentLockSchema, lockValue, 'Environment lock'),
      baseline: parseState(
        machineEnvironmentBaselineSchema,
        baselineValue,
        'Machine baseline',
      ),
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
    if (isNotFound(error))
      throw new StackStateError(
        'environment-not-found',
        'main does not exist. Run stack init first.',
        { cause: error },
      );
    if (error instanceof StackStateError) throw error;
    throw new StackStateError(
      'invalid-state',
      'main state is corrupt or unreadable. Stack made no changes.',
      { cause: error },
    );
  }
};

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
      | 'invalid-state'
      | 'ambiguous-home',
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

/**
 * Relative markers that identify a directory as a STAK state home (Phase R3). Each is a
 * product-owned path that an unrelated or empty directory never contains, and each can
 * exist INDEPENDENTLY — a machine with only `auth.json` (logged in, nothing else) or
 * only a Memory store is still a recognizable home. Mere directory existence is NOT a
 * marker. Kept in sync with `statePaths` (core), `memoryStorePaths` (@stack/memory), and
 * the Cloud credential file (`auth.json`).
 */
const STATE_MARKERS: readonly string[] = [
  'machine.json', // core machine identity
  'auth.json', // Cloud credential
  path.join('environments', 'main', 'environment.yaml'), // desired-state manifest
  path.join('environments', 'main', 'stack.lock.json'), // resolved lockfile
  path.join('memory', 'manifests', 'current.json'), // Memory manifest
  path.join('memory', 'objects'), // Memory content store
  path.join('memory', 'projects-local.json'), // machine-local project registry
  path.join('memory', 'recovery-state.json'), // recovery provenance
];

/**
 * Paths to exclude from Cloud bundle and state uploads. These are machine-local
 * files that should never be synced across machines. Kept in sync with bundling
 * code that filters state before upload.
 */
export const STATE_EXCLUDE_PATHS: readonly string[] = [
  path.join('memory', 'recovery-state.json'), // recovery provenance
  path.join('memory', 'canonical', 'base.json'), // machine-local merge base
  path.join('memory', 'canonical', 'merge.json'), // machine-local pending merge
  path.join('memory', 'projections'), // machine-local native/canonical sync state (directory)
  path.join('memory', '.memory.lock'), // machine-local Memory lock
  path.join('memory', '.memory.lock.clearing'), // machine-local Memory lock guard
  path.join('memory', 'agent-exports'), // machine-local Codex/Cursor export state and settings (directory)
];

/**
 * Whether `home` holds recognizable STAK state (any one marker). Read-only; never
 * creates anything. Used to adopt a legacy `~/.stack` in place without moving data.
 */
export const hasRecognizableStakState = (home: string): boolean => {
  const root = path.resolve(home);
  return STATE_MARKERS.some((marker) => existsSync(path.join(root, marker)));
};

/** Canonical form for comparing two home paths (Windows is case-insensitive). */
const canonicalHome = (candidate: string): string => {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * The explicit home from environment variables, or undefined when neither is set.
 * `STAK_HOME` is preferred; `STACK_HOME` is the supported legacy alias. If BOTH are set
 * and point at DIFFERENT locations we FAIL CLOSED rather than guess, merge, or copy.
 */
const explicitHome = (env: NodeJS.ProcessEnv): string | undefined => {
  const preferred = env.STAK_HOME;
  const legacy = env.STACK_HOME;
  if (preferred !== undefined && legacy !== undefined) {
    if (canonicalHome(preferred) !== canonicalHome(legacy))
      throw new StackStateError(
        'ambiguous-home',
        'STAK found different locations for STAK_HOME and legacy STACK_HOME. ' +
          'Unset one, or point both at the same state directory. No changes were made.',
      );
    return preferred;
  }
  return preferred ?? legacy;
};

/**
 * Resolve the STAK state home (Phase R3). Precedence:
 *  1. explicit `STAK_HOME` / `STACK_HOME` (conflict → fail closed);
 *  2. otherwise discover implicitly: prefer `~/.stak`, but adopt a legacy `~/.stack`
 *     IN PLACE when it (and only it) holds recognizable state. If BOTH `~/.stak` and
 *     `~/.stack` hold recognizable state, fail closed (never guess, move, or merge).
 * New installs default to `~/.stak`. Read-only: never creates a directory (lazy/atomic
 * creation stays at the mutation boundary).
 */
export const resolveStackHome = (
  options: ResolveStackHomeOptions = {},
): string => {
  const env = options.env ?? process.env;
  const explicit = explicitHome(env);
  if (explicit !== undefined) return path.resolve(explicit);

  const homeDir = options.homeDir ?? os.homedir();
  const preferredHome = path.join(homeDir, '.stak');
  const legacyHome = path.join(homeDir, '.stack');
  const preferredHasState = hasRecognizableStakState(preferredHome);
  const legacyHasState = hasRecognizableStakState(legacyHome);

  if (preferredHasState && legacyHasState)
    throw new StackStateError(
      'ambiguous-home',
      `STAK found state in both ${preferredHome} and legacy ${legacyHome}. ` +
        'No state was moved or merged. Set STAK_HOME explicitly to the state ' +
        'directory you intend to use.',
    );
  // Adopt a legacy ~/.stack in place only when it is the sole home with state.
  if (legacyHasState && !preferredHasState) return path.resolve(legacyHome);
  // New install, or state already under ~/.stak → the preferred home.
  return path.resolve(preferredHome);
};

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
        'main does not exist. Run stak init first.',
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

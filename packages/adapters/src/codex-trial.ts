import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  assertPathWithin,
  hashSkillDirectory,
  pathIsWithin,
  pathsEqual,
} from '@stack/shared';
import {
  tryExitResultSchema,
  tryPreparationResultSchema,
  trySessionSchema,
} from '@stack/spec';
import type {
  AgentDetection,
  TryExitResult,
  TryPreparationResult,
  TryResolvedEnvironment,
  TrySession,
} from '@stack/spec';
import { materializeStoredSkill } from '@stack/store';

import { isSafeCodexSkillName, launchCodex } from './codex.js';
import type { SpawnProcess } from './codex.js';
import {
  TryAuthBridgeFailedError,
  TryRuntimeCleanupFailedError,
  TryRuntimePreparationFailedError,
  UnsafeRuntimePathError,
} from './errors.js';

const secureDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
};
const bridgeNames = (names: string[]) =>
  names.filter(
    (name) =>
      name === 'config.toml' ||
      name === 'auth.json' ||
      (name.endsWith('.config.toml') &&
        !name.includes('/') &&
        !name.includes('\\')),
  );
export const resolveUserCodexHome = (options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}) =>
  path.resolve(
    options.env?.CODEX_HOME ??
      path.join(options.homeDir ?? os.homedir(), '.codex'),
  );

export const bridgeCodexRuntimeState = async (options: {
  sourceCodexHome: string;
  runtimeCodexHome: string;
}): Promise<string[]> => {
  await secureDirectory(options.runtimeCodexHome);
  let names: string[];
  try {
    names = await readdir(options.sourceCodexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new TryAuthBridgeFailedError({ cause: error });
  }
  const copied: string[] = [];
  try {
    for (const name of bridgeNames(names)) {
      const source = path.join(options.sourceCodexHome, name);
      if (!(await lstat(source)).isFile()) continue;
      const target = path.join(options.runtimeCodexHome, name);
      await copyFile(source, target);
      if (process.platform !== 'win32') await chmod(target, 0o600);
      copied.push(name);
    }
    return copied.sort();
  } catch (error) {
    throw new TryAuthBridgeFailedError({ cause: error });
  }
};

const writeSession = async (directory: string, session: TrySession) => {
  await writeFile(
    path.join(directory, 'session.json'),
    `${JSON.stringify(trySessionSchema.parse(session), null, 2)}\n`,
    'utf8',
  );
};

const removeOwnedRuntimePath = async (
  runtimeRoot: string,
  target: string,
): Promise<void> => {
  await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: target });
  await rm(target, { recursive: true, force: true });
};

const assertCodexTryIsolation = async (options: {
  runtimeRoot: string;
  sessionRoot: string;
  workspacePath: string;
  runtimeHomePath: string;
  runtimeCodexHomePath: string;
  skillRoot: string;
  realHome: string;
  realCodexHome: string;
}) => {
  try {
    await assertPathWithin({
      ownedRoot: options.runtimeRoot,
      proposedPath: options.sessionRoot,
    });
    for (const proposedPath of [
      options.workspacePath,
      options.runtimeHomePath,
      options.runtimeCodexHomePath,
    ])
      await assertPathWithin({
        ownedRoot: options.sessionRoot,
        proposedPath,
      });
    await assertPathWithin({
      ownedRoot: options.workspacePath,
      proposedPath: options.skillRoot,
    });
    if (
      (await pathsEqual({
        left: options.runtimeHomePath,
        right: options.realHome,
      })) ||
      (await pathsEqual({
        left: options.runtimeCodexHomePath,
        right: options.realCodexHome,
      })) ||
      (await pathIsWithin({
        ownedRoot: path.join(options.realHome, '.agents', 'skills'),
        proposedPath: options.skillRoot,
        allowRoot: true,
      })) ||
      (await pathIsWithin({
        ownedRoot: path.join(options.realCodexHome, 'skills'),
        proposedPath: options.skillRoot,
        allowRoot: true,
      }))
    )
      throw new UnsafeRuntimePathError();
  } catch (error) {
    if (error instanceof UnsafeRuntimePathError) throw error;
    throw new UnsafeRuntimePathError();
  }
};

const assertOwnedReadySession = async (options: {
  stackHome: string;
  session: TrySession;
}): Promise<void> => {
  const runtimeRoot = path.resolve(options.stackHome, 'runtime');
  const sessionRoot = path.resolve(runtimeRoot, options.session.sessionId);
  const expected = {
    runtimeRootPath: runtimeRoot,
    workspacePath: path.join(sessionRoot, 'workspace'),
    runtimeHomePath: path.join(sessionRoot, 'home'),
    runtimeCodexHomePath: path.join(sessionRoot, 'codex-home'),
  };
  for (const pair of [
    { left: options.session.runtimeRootPath, right: expected.runtimeRootPath },
    { left: options.session.workspacePath, right: expected.workspacePath },
    { left: options.session.runtimeHomePath, right: expected.runtimeHomePath },
    {
      left: options.session.runtimeCodexHomePath,
      right: expected.runtimeCodexHomePath,
    },
  ])
    if (!(await pathsEqual(pair))) throw new UnsafeRuntimePathError();
  await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: sessionRoot });
  const marker = trySessionSchema.parse(
    JSON.parse(await readFile(path.join(sessionRoot, 'session.json'), 'utf8')),
  );
  if (marker.status !== 'ready' || !isDeepStrictEqual(marker, options.session))
    throw new UnsafeRuntimePathError();
};

export const prepareCodexTryRuntime = async (options: {
  stackHome: string;
  trial: TryResolvedEnvironment;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  idFactory?: () => string;
  ownerPid?: number;
  materialize?: typeof materializeStoredSkill;
}): Promise<TryPreparationResult> => {
  const sessionId = `try_${(options.idFactory ?? randomUUID)()}`;
  const runtimeRoot = path.resolve(options.stackHome, 'runtime');
  const finalDirectory = path.join(runtimeRoot, sessionId);
  const workspacePath = path.join(finalDirectory, 'workspace');
  const runtimeHomePath = path.join(finalDirectory, 'home');
  const runtimeCodexHomePath = path.join(finalDirectory, 'codex-home');
  const skillRoot = path.join(workspacePath, '.agents', 'skills');
  const realHome = path.resolve(options.homeDir ?? os.homedir());
  const realCodexHome = resolveUserCodexHome({
    homeDir: realHome,
    ...(options.env ? { env: options.env } : {}),
  });
  let finalOwned = false;
  try {
    await assertCodexTryIsolation({
      runtimeRoot,
      sessionRoot: finalDirectory,
      workspacePath,
      runtimeHomePath,
      runtimeCodexHomePath,
      skillRoot,
      realHome,
      realCodexHome,
    });
    await secureDirectory(runtimeRoot);
    await mkdir(finalDirectory, { recursive: false, mode: 0o700 });
    finalOwned = true;
    if (process.platform !== 'win32') await chmod(finalDirectory, 0o700);
    await secureDirectory(runtimeHomePath);
    await secureDirectory(runtimeCodexHomePath);
    await mkdir(skillRoot, { recursive: true });
    const bridgedFiles = await bridgeCodexRuntimeState({
      sourceCodexHome: realCodexHome,
      runtimeCodexHome: runtimeCodexHomePath,
    });
    const materialize = options.materialize ?? materializeStoredSkill;
    const skills: TrySession['resolvedSkills'] = [];
    for (const skill of options.trial.environment.skills) {
      if (!isSafeCodexSkillName(skill.name)) throw new UnsafeRuntimePathError();
      const targetPath = path.join(skillRoot, skill.name);
      await materialize({
        stackHome: options.stackHome,
        contentHash: skill.contentHash,
        targetPath,
      });
      const actual = (await hashSkillDirectory(targetPath)).hash;
      if (actual !== skill.contentHash)
        throw new TryRuntimePreparationFailedError(
          'A materialized trial Skill failed integrity verification.',
        );
      skills.push({
        entryId: skill.entryId,
        name: skill.name,
        contentHash: skill.contentHash,
        targetPath,
      });
    }
    const session: TrySession = {
      schemaVersion: 1,
      sessionId,
      agent: 'codex',
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      ownerPid: options.ownerPid ?? process.pid,
      source: { type: 'local-stack', displayName: options.trial.stackName },
      runtimeRootPath: runtimeRoot,
      workspacePath,
      runtimeHomePath,
      runtimeCodexHomePath,
      resolvedSkills: skills,
      status: 'ready',
    };
    await writeSession(finalDirectory, session);
    return tryPreparationResultSchema.parse({ session, bridgedFiles });
  } catch (error) {
    if (finalOwned)
      try {
        await removeOwnedRuntimePath(runtimeRoot, finalDirectory);
      } catch (cleanupError) {
        throw new TryRuntimeCleanupFailedError({ cause: cleanupError });
      }
    if (
      error instanceof TryRuntimePreparationFailedError ||
      error instanceof UnsafeRuntimePathError ||
      error instanceof TryAuthBridgeFailedError
    )
      throw error;
    throw new TryRuntimePreparationFailedError(undefined, { cause: error });
  }
};

export const cleanupCodexTryRuntime = async (options: {
  stackHome: string;
  session: TrySession;
}): Promise<void> => {
  const { session } = options;
  const runtimeRoot = path.resolve(options.stackHome, 'runtime');
  const directory = path.resolve(runtimeRoot, session.sessionId);
  const expectedWorkspace = path.join(directory, 'workspace');
  const expectedHome = path.join(directory, 'home');
  const expectedCodexHome = path.join(directory, 'codex-home');
  const sessionPathsValid =
    (await pathsEqual({ left: session.runtimeRootPath, right: runtimeRoot })) &&
    (await pathsEqual({
      left: session.workspacePath,
      right: expectedWorkspace,
    })) &&
    (await pathsEqual({
      left: session.runtimeHomePath,
      right: expectedHome,
    })) &&
    (await pathsEqual({
      left: session.runtimeCodexHomePath,
      right: expectedCodexHome,
    }));
  if (!sessionPathsValid)
    throw new TryRuntimeCleanupFailedError({
      cause: new Error(
        'Runtime paths are outside the owned session directory.',
      ),
    });
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new TryRuntimeCleanupFailedError({ cause: error });
  }
  try {
    await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: directory });
    const marker = trySessionSchema.parse(
      JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')),
    );
    if (marker.sessionId !== session.sessionId)
      throw new Error('Runtime marker does not match the requested session.');
    for (const pair of [
      { left: marker.runtimeRootPath, right: runtimeRoot },
      { left: marker.workspacePath, right: expectedWorkspace },
      { left: marker.runtimeHomePath, right: expectedHome },
      { left: marker.runtimeCodexHomePath, right: expectedCodexHome },
    ])
      if (!(await pathsEqual(pair)))
        throw new Error('Runtime marker does not match the requested session.');
    await removeOwnedRuntimePath(runtimeRoot, directory);
  } catch (error) {
    throw new TryRuntimeCleanupFailedError({ cause: error });
  }
};

export const launchCodexTryRuntime = async (options: {
  stackHome: string;
  preparation: TryPreparationResult;
  detection: AgentDetection;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
}): Promise<TryExitResult> => {
  const session = options.preparation.session;
  const root = path.parse(session.runtimeHomePath).root;
  const childEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    HOME: session.runtimeHomePath,
    USERPROFILE: session.runtimeHomePath,
    CODEX_HOME: session.runtimeCodexHomePath,
    ...(process.platform === 'win32'
      ? {
          HOMEDRIVE: root.replace(/[\\/]$/, ''),
          HOMEPATH: session.runtimeHomePath.slice(root.length - 1),
        }
      : {}),
  };
  let exitCode: number | null;
  let signal: string | null | undefined;
  let isolationVerified = false;
  let ownershipVerified = false;
  try {
    await assertOwnedReadySession({
      stackHome: options.stackHome,
      session,
    });
    ownershipVerified = true;
    const inheritedEnvironment = options.env ?? process.env;
    const realHome = path.resolve(
      inheritedEnvironment.HOME ??
        inheritedEnvironment.USERPROFILE ??
        os.homedir(),
    );
    const realCodexHome = resolveUserCodexHome({
      homeDir: realHome,
      env: inheritedEnvironment,
    });
    await assertCodexTryIsolation({
      runtimeRoot: path.resolve(options.stackHome, 'runtime'),
      sessionRoot: path.dirname(session.workspacePath),
      workspacePath: session.workspacePath,
      runtimeHomePath: session.runtimeHomePath,
      runtimeCodexHomePath: session.runtimeCodexHomePath,
      skillRoot: path.join(session.workspacePath, '.agents', 'skills'),
      realHome,
      realCodexHome,
    });
    isolationVerified = true;
    await writeSession(path.dirname(session.workspacePath), {
      ...session,
      status: 'running',
    });
    const result = await launchCodex({
      detection: options.detection,
      cwd: session.workspacePath,
      env: childEnv,
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    });
    exitCode = result.exitCode;
    signal = result.signal;
    await writeSession(path.dirname(session.workspacePath), {
      ...session,
      status: 'exited',
    });
  } catch (error) {
    if (isolationVerified)
      await writeSession(path.dirname(session.workspacePath), {
        ...session,
        status: 'failed',
      }).catch(() => undefined);
    throw error;
  } finally {
    if (ownershipVerified)
      await cleanupCodexTryRuntime({ stackHome: options.stackHome, session });
  }
  return tryExitResultSchema.parse({
    sessionId: session.sessionId,
    exitCode,
    signal: signal ?? null,
    cleaned: true,
  });
};

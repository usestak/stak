import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rmdir,
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
import { tryExitResultSchema, tryPreparationResultSchema } from '@stack/spec';
import type {
  AgentDetection,
  TryCleanupComponent,
  TryCleanupDiagnostic,
  TryExitResult,
  TryPreparationResult,
  TryResolvedEnvironment,
  TrySession,
} from '@stack/spec';
import { materializeStoredSkill } from '@stack/store';

import { isSafeCodexSkillName, launchAgent } from './codex.js';
import type { SpawnProcess } from './codex.js';
import {
  CursorTryAuthRequiredError,
  TryAuthBridgeFailedError,
  TryRuntimeCleanupFailedError,
  TryRuntimePreparationFailedError,
  UnsafeRuntimePathError,
} from './errors.js';
import {
  defaultRemoveRuntimeEntry,
  isOwnedMetadataEntry,
  readSessionMarker,
  realSleep,
  removeOwnedRuntimePath,
  removeWithBoundedRetry,
  safeCleanupDiagnostic,
  secureDirectory,
  writeSession,
  type TryCleanupControls,
  type TryCleanupOutcome,
} from './trial-runtime-shared.js';

// Cursor's documented headless auth path is an env var — `cli-config.json`
// (editor/model/permissions settings, no credentials) is bridged, verbatim,
// below. An interactive `agent login` session is stored separately in
// `auth.json`, whose location the official CLI computes from HOME/APPDATA,
// not from CURSOR_CONFIG_DIR (verified against the installed CLI's own
// resolver): `%APPDATA%\Cursor\auth.json` on Windows, `~/.cursor/auth.json`
// on macOS, `$XDG_CONFIG_HOME/cursor/auth.json` (or `~/.config/...`)
// elsewhere. The isolated runtime overrides HOME/USERPROFILE but never
// APPDATA, so on Windows the real `auth.json` stays reachable with no
// copying at all. On macOS/Linux the HOME override hides it, so — mirroring
// the Claude trial's `.credentials.json` bridge — exactly that one file is
// copied into the isolated HOME's equivalent path by `bridgeCursorLoginSession`
// below; its contents are never read, logged, or otherwise inspected.
const bridgeNames = (names: string[]) =>
  names.filter((name) => name === 'cli-config.json');

export const resolveUserCursorHome = (options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}) =>
  path.resolve(
    options.env?.CURSOR_CONFIG_DIR ??
      path.join(options.homeDir ?? os.homedir(), '.cursor'),
  );

// Matches the official Cursor Agent CLI's own `getAuthFilePath` resolver
// (same per-platform precedence: env override first, HOME-derived default
// otherwise) so this can both detect a real `agent login` session and, on
// platforms where HOME isolation hides it, bridge to exactly where the
// isolated child process will look.
export const resolveCursorAuthFilePath = (options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string => {
  const env = options.env ?? {};
  const homeDir = options.homeDir ?? os.homedir();
  if (process.platform === 'win32')
    return path.join(
      env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
      'Cursor',
      'auth.json',
    );
  if (process.platform === 'darwin')
    return path.join(homeDir, '.cursor', 'auth.json');
  return path.join(
    env.XDG_CONFIG_HOME || path.join(homeDir, '.config'),
    'cursor',
    'auth.json',
  );
};

// The isolated runtime never sets APPDATA, so on Windows the real auth.json
// stays reachable unbridged (see resolveCursorAuthFilePath above) — this is
// only ever used for macOS/Linux, where HOME is overridden.
const resolveIsolatedCursorAuthFilePath = (runtimeHomePath: string): string =>
  process.platform === 'darwin'
    ? path.join(runtimeHomePath, '.cursor', 'auth.json')
    : path.join(runtimeHomePath, '.config', 'cursor', 'auth.json');

export const cursorLoginSessionExists = async (
  authFilePath: string,
): Promise<boolean> => {
  try {
    return (await lstat(authFilePath)).isFile();
  } catch {
    return false;
  }
};

// Copies only the login-session file itself (never its contents, into logs or
// elsewhere) into the isolated HOME so a normally-authenticated user is not
// forced to export CURSOR_API_KEY/CURSOR_AUTH_TOKEN. A no-op on Windows,
// where the real file is already reachable without copying anything.
export const bridgeCursorLoginSession = async (options: {
  realAuthFilePath: string;
  runtimeHomePath: string;
}): Promise<boolean> => {
  if (process.platform === 'win32') return false;
  if (!(await cursorLoginSessionExists(options.realAuthFilePath))) return false;
  const target = resolveIsolatedCursorAuthFilePath(options.runtimeHomePath);
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(options.realAuthFilePath, target);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    throw new TryAuthBridgeFailedError('Cursor', { cause: error });
  }
};

export const bridgeCursorRuntimeState = async (options: {
  sourceCursorHome: string;
  runtimeCursorHome: string;
}): Promise<string[]> => {
  await secureDirectory(options.runtimeCursorHome);
  let names: string[];
  try {
    names = await readdir(options.sourceCursorHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new TryAuthBridgeFailedError('Cursor', { cause: error });
  }
  const copied: string[] = [];
  try {
    for (const name of bridgeNames(names)) {
      const source = path.join(options.sourceCursorHome, name);
      if (!(await lstat(source)).isFile()) continue;
      const target = path.join(options.runtimeCursorHome, name);
      await copyFile(source, target);
      if (process.platform !== 'win32') await chmod(target, 0o600);
      copied.push(name);
    }
    return copied.sort();
  } catch (error) {
    throw new TryAuthBridgeFailedError('Cursor', { cause: error });
  }
};

const assertCursorTryIsolation = async (options: {
  runtimeRoot: string;
  sessionRoot: string;
  workspacePath: string;
  runtimeHomePath: string;
  runtimeCursorHomePath: string;
  skillRoot: string;
  realHome: string;
  realCursorHome: string;
}) => {
  try {
    await assertPathWithin({
      ownedRoot: options.runtimeRoot,
      proposedPath: options.sessionRoot,
    });
    for (const proposedPath of [
      options.workspacePath,
      options.runtimeHomePath,
      options.runtimeCursorHomePath,
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
        left: options.runtimeCursorHomePath,
        right: options.realCursorHome,
      })) ||
      (await pathIsWithin({
        ownedRoot: path.join(options.realHome, '.agents', 'skills'),
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
    runtimeAgentHomePath: path.join(sessionRoot, 'cursor-home'),
  };
  for (const pair of [
    { left: options.session.runtimeRootPath, right: expected.runtimeRootPath },
    { left: options.session.workspacePath, right: expected.workspacePath },
    { left: options.session.runtimeHomePath, right: expected.runtimeHomePath },
    {
      left: options.session.runtimeAgentHomePath ?? '',
      right: expected.runtimeAgentHomePath,
    },
  ])
    if (!(await pathsEqual(pair))) throw new UnsafeRuntimePathError();
  await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: sessionRoot });
  const marker = await readSessionMarker(sessionRoot);
  if (marker.status !== 'ready' || !isDeepStrictEqual(marker, options.session))
    throw new UnsafeRuntimePathError();
};

export const prepareCursorTryRuntime = async (options: {
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
  const runtimeCursorHomePath = path.join(finalDirectory, 'cursor-home');
  // Cursor's normal binding root is shared with Codex (.agents/skills) by
  // design (avoids .cursor/skills' Cloud sync policy) — reused here since the
  // trial workspace is disposable and has no real sync-policy exposure.
  const skillRoot = path.join(workspacePath, '.agents', 'skills');
  const realHome = path.resolve(options.homeDir ?? os.homedir());
  const realCursorHome = resolveUserCursorHome({
    homeDir: realHome,
    ...(options.env ? { env: options.env } : {}),
  });
  let finalOwned = false;
  try {
    await assertCursorTryIsolation({
      runtimeRoot,
      sessionRoot: finalDirectory,
      workspacePath,
      runtimeHomePath,
      runtimeCursorHomePath,
      skillRoot,
      realHome,
      realCursorHome,
    });
    await secureDirectory(runtimeRoot);
    await mkdir(finalDirectory, { recursive: false, mode: 0o700 });
    finalOwned = true;
    if (process.platform !== 'win32') await chmod(finalDirectory, 0o700);
    await secureDirectory(runtimeHomePath);
    await secureDirectory(runtimeCursorHomePath);
    await mkdir(skillRoot, { recursive: true });
    const bridgedFiles = await bridgeCursorRuntimeState({
      sourceCursorHome: realCursorHome,
      runtimeCursorHome: runtimeCursorHomePath,
    });
    await bridgeCursorLoginSession({
      realAuthFilePath: resolveCursorAuthFilePath({
        homeDir: realHome,
        ...(options.env ? { env: options.env } : {}),
      }),
      runtimeHomePath,
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
      agent: 'cursor',
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      ownerPid: options.ownerPid ?? process.pid,
      source: { type: 'local-stack', displayName: options.trial.stackName },
      runtimeRootPath: runtimeRoot,
      workspacePath,
      runtimeHomePath,
      runtimeAgentHomePath: runtimeCursorHomePath,
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
        throw new TryRuntimeCleanupFailedError('Cursor', {
          cause: cleanupError,
        });
      }
    if (
      error instanceof TryRuntimePreparationFailedError ||
      error instanceof UnsafeRuntimePathError ||
      error instanceof TryAuthBridgeFailedError
    )
      throw error;
    throw new TryRuntimePreparationFailedError(
      'The isolated Cursor trial runtime could not be prepared.',
      { cause: error },
    );
  }
};

export const cleanupCursorTryRuntime = async (
  options: {
    stackHome: string;
    session: TrySession;
  } & TryCleanupControls,
): Promise<TryCleanupOutcome> => {
  const { session } = options;
  const runtimeRoot = path.resolve(options.stackHome, 'runtime');
  const directory = path.resolve(runtimeRoot, session.sessionId);
  const expectedWorkspace = path.join(directory, 'workspace');
  const expectedHome = path.join(directory, 'home');
  const expectedCursorHome = path.join(directory, 'cursor-home');
  const remove = options.removeEntry ?? defaultRemoveRuntimeEntry;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const settleDelayMs = options.settleDelayMs ?? 250;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => new Date());

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
      left: session.runtimeAgentHomePath ?? '',
      right: expectedCursorHome,
    }));
  if (!sessionPathsValid)
    throw new TryRuntimeCleanupFailedError('Cursor', {
      cause: new Error(
        'Runtime paths are outside the owned session directory.',
      ),
    });
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { cleaned: true };
    throw new TryRuntimeCleanupFailedError('Cursor', { cause: error });
  }
  let marker: TrySession;
  try {
    await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: directory });
    marker = await readSessionMarker(directory);
    if (marker.sessionId !== session.sessionId)
      throw new Error('Runtime marker does not match the requested session.');
    for (const pair of [
      { left: marker.runtimeRootPath, right: runtimeRoot },
      { left: marker.workspacePath, right: expectedWorkspace },
      { left: marker.runtimeHomePath, right: expectedHome },
      { left: marker.runtimeAgentHomePath ?? '', right: expectedCursorHome },
    ])
      if (!(await pathsEqual(pair)))
        throw new Error('Runtime marker does not match the requested session.');
  } catch (error) {
    throw new TryRuntimeCleanupFailedError('Cursor', { cause: error });
  }

  const recordFailure = async (
    component: TryCleanupComponent,
    error: unknown,
  ): Promise<TryCleanupOutcome> => {
    const diagnostic: TryCleanupDiagnostic = safeCleanupDiagnostic(
      component,
      error,
      now,
    );
    await writeSession(directory, {
      ...marker,
      status: 'cleanup-failed',
      cleanup: diagnostic,
    }).catch(() => undefined);
    return { cleaned: false, diagnostic, runtimePath: directory };
  };

  await writeSession(directory, { ...marker, status: 'cleaning' });
  if (settleDelayMs > 0) await sleep(settleDelayMs);

  const components: Array<{ name: TryCleanupComponent; path: string }> = [
    { name: 'workspace', path: expectedWorkspace },
    { name: 'home', path: expectedHome },
    { name: 'agent-home', path: expectedCursorHome },
  ];
  for (const component of components) {
    try {
      await removeWithBoundedRetry(
        component.path,
        remove,
        maxRetries,
        retryDelayMs,
        sleep,
      );
    } catch (error) {
      return recordFailure(component.name, error);
    }
  }

  let residual: string[];
  try {
    residual = await readdir(directory);
  } catch (error) {
    return recordFailure('session-root', error);
  }
  if (residual.some((name) => !isOwnedMetadataEntry(name)))
    return recordFailure('unexpected-entry', { code: 'EEXIST' });

  try {
    for (const name of residual.filter((entry) => entry !== 'session.json'))
      await remove(path.join(directory, name));
    await remove(path.join(directory, 'session.json'));
  } catch (error) {
    return recordFailure('session-root', error);
  }
  try {
    await removeWithBoundedRetry(
      directory,
      (target) => rmdir(target),
      maxRetries,
      retryDelayMs,
      sleep,
    );
  } catch (error) {
    return recordFailure('session-root', error);
  }
  return { cleaned: true };
};

export const recoverStaleCursorTryRuntimes = async (
  options: { stackHome: string } & TryCleanupControls,
): Promise<{ scanned: number; cleaned: number; retained: number }> => {
  const runtimeRoot = path.resolve(options.stackHome, 'runtime');
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch {
    return { scanned: 0, cleaned: 0, retained: 0 };
  }
  let scanned = 0;
  let cleaned = 0;
  let retained = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^try_[A-Za-z0-9_-]{8,}$/.test(entry.name))
      continue;
    const directory = path.join(runtimeRoot, entry.name);
    let marker: TrySession;
    try {
      marker = await readSessionMarker(directory);
    } catch {
      continue;
    }
    if (marker.agent !== 'cursor') continue;
    if (marker.status !== 'cleanup-failed') continue;
    if (marker.sessionId !== entry.name) continue;
    scanned += 1;
    try {
      const outcome = await cleanupCursorTryRuntime({
        ...options,
        session: marker,
      });
      if (outcome.cleaned) cleaned += 1;
      else retained += 1;
    } catch {
      retained += 1;
    }
  }
  return { scanned, cleaned, retained };
};

// Cursor's officially documented headless auth path is an env var — forward
// it if present. A normal `agent login` session (see resolveCursorAuthFilePath
// / bridgeCursorLoginSession above) is also accepted. If none of the three
// are available, fail fast and cleanly before launching rather than starting
// an unauthenticated (or silently-stale) session.
const cursorAuthEnv = (
  env: NodeJS.ProcessEnv,
): Partial<
  Pick<NodeJS.ProcessEnv, 'CURSOR_API_KEY' | 'CURSOR_AUTH_TOKEN'>
> => ({
  ...(env.CURSOR_API_KEY ? { CURSOR_API_KEY: env.CURSOR_API_KEY } : {}),
  ...(env.CURSOR_AUTH_TOKEN
    ? { CURSOR_AUTH_TOKEN: env.CURSOR_AUTH_TOKEN }
    : {}),
});

export const launchCursorTryRuntime = async (options: {
  stackHome: string;
  preparation: TryPreparationResult;
  detection: AgentDetection;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  cleanup?: TryCleanupControls;
}): Promise<TryExitResult> => {
  const session = options.preparation.session;
  const inheritedEnvironment = options.env ?? process.env;
  const authForward = cursorAuthEnv(inheritedEnvironment);
  const runtimeCursorHomePath = session.runtimeAgentHomePath ?? '';
  const root = path.parse(session.runtimeHomePath).root;
  const childEnv: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    HOME: session.runtimeHomePath,
    USERPROFILE: session.runtimeHomePath,
    CURSOR_CONFIG_DIR: runtimeCursorHomePath,
    ...authForward,
    ...(process.platform === 'win32'
      ? {
          HOMEDRIVE: root.replace(/[\\/]$/, ''),
          HOMEPATH: session.runtimeHomePath.slice(root.length - 1),
        }
      : {}),
  };
  let exitCode: number | null = null;
  let signal: string | null | undefined;
  let isolationVerified = false;
  let ownershipVerified = false;
  let launchError: unknown;
  try {
    await assertOwnedReadySession({ stackHome: options.stackHome, session });
    ownershipVerified = true;
    const realHome = path.resolve(
      inheritedEnvironment.HOME ??
        inheritedEnvironment.USERPROFILE ??
        os.homedir(),
    );
    if (
      !authForward.CURSOR_API_KEY &&
      !authForward.CURSOR_AUTH_TOKEN &&
      !(await cursorLoginSessionExists(
        resolveCursorAuthFilePath({
          homeDir: realHome,
          env: inheritedEnvironment,
        }),
      ))
    )
      throw new CursorTryAuthRequiredError();
    const realCursorHome = resolveUserCursorHome({
      homeDir: realHome,
      env: inheritedEnvironment,
    });
    await assertCursorTryIsolation({
      runtimeRoot: path.resolve(options.stackHome, 'runtime'),
      sessionRoot: path.dirname(session.workspacePath),
      workspacePath: session.workspacePath,
      runtimeHomePath: session.runtimeHomePath,
      runtimeCursorHomePath,
      skillRoot: path.join(session.workspacePath, '.agents', 'skills'),
      realHome,
      realCursorHome,
    });
    isolationVerified = true;
    await writeSession(path.dirname(session.workspacePath), {
      ...session,
      status: 'running',
    });
    const result = await launchAgent({
      agent: 'cursor',
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
    launchError = error;
    if (isolationVerified)
      await writeSession(path.dirname(session.workspacePath), {
        ...session,
        status: 'failed',
      }).catch(() => undefined);
  }
  let cleanupOutcome: TryCleanupOutcome = { cleaned: true };
  if (ownershipVerified)
    cleanupOutcome = await cleanupCursorTryRuntime({
      stackHome: options.stackHome,
      session,
      ...(options.cleanup ?? {}),
    });
  if (launchError) throw launchError;
  return tryExitResultSchema.parse({
    sessionId: session.sessionId,
    exitCode,
    signal: signal ?? null,
    cleaned: cleanupOutcome.cleaned,
    ...(cleanupOutcome.cleaned
      ? {}
      : {
          cleanup: cleanupOutcome.diagnostic,
          retainedRuntimePath: cleanupOutcome.runtimePath,
        }),
  });
};

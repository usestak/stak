import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rmdir,
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

// Only these two file names are ever bridged from the real Claude Code config
// directory into an isolated trial. `.credentials.json` carries the OAuth
// token Claude Code uses on Linux/Windows when CLAUDE_CONFIG_DIR is set (on
// macOS, auth instead lives in Keychain and is unaffected by this bridge —
// nothing to copy, nothing missing). `settings.json` carries user preferences
// but is sanitized first; everything else under ~/.claude (transcripts,
// history, caches, plugins) is never read or copied.
const bridgeNames = (names: string[]) =>
  names.filter(
    (name) => name === '.credentials.json' || name === 'settings.json',
  );

// Keys removed from a bridged `settings.json`: `hooks` can spawn arbitrary
// background processes, `mcpServers`/`plugins` can reach the network or load
// unrelated personal integrations into the disposable trial. Every other key
// (theme, model preferences, etc.) is preserved verbatim.
const excludedSettingsKeys = new Set(['hooks', 'plugins', 'mcpServers']);
export const sanitizeClaudeSettingsJson = (text: string): string => {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !excludedSettingsKeys.has(key)),
  );
  return JSON.stringify(sanitized, null, 2);
};

export const resolveUserClaudeHome = (options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}) =>
  path.resolve(
    options.env?.CLAUDE_CONFIG_DIR ??
      path.join(options.homeDir ?? os.homedir(), '.claude'),
  );

export const bridgeClaudeRuntimeState = async (options: {
  sourceClaudeHome: string;
  runtimeClaudeHome: string;
}): Promise<string[]> => {
  await secureDirectory(options.runtimeClaudeHome);
  let names: string[];
  try {
    names = await readdir(options.sourceClaudeHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new TryAuthBridgeFailedError('Claude', { cause: error });
  }
  const copied: string[] = [];
  try {
    for (const name of bridgeNames(names)) {
      const source = path.join(options.sourceClaudeHome, name);
      if (!(await lstat(source)).isFile()) continue;
      const target = path.join(options.runtimeClaudeHome, name);
      if (name === 'settings.json') {
        await writeFile(
          target,
          sanitizeClaudeSettingsJson(await readFile(source, 'utf8')),
          'utf8',
        );
      } else {
        await copyFile(source, target);
      }
      if (process.platform !== 'win32') await chmod(target, 0o600);
      copied.push(name);
    }
    return copied.sort();
  } catch (error) {
    throw new TryAuthBridgeFailedError('Claude', { cause: error });
  }
};

const assertClaudeTryIsolation = async (options: {
  runtimeRoot: string;
  sessionRoot: string;
  workspacePath: string;
  runtimeHomePath: string;
  runtimeClaudeHomePath: string;
  skillRoot: string;
  realHome: string;
  realClaudeHome: string;
}) => {
  try {
    await assertPathWithin({
      ownedRoot: options.runtimeRoot,
      proposedPath: options.sessionRoot,
    });
    for (const proposedPath of [
      options.workspacePath,
      options.runtimeHomePath,
      options.runtimeClaudeHomePath,
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
        left: options.runtimeClaudeHomePath,
        right: options.realClaudeHome,
      })) ||
      (await pathIsWithin({
        ownedRoot: path.join(options.realHome, '.claude', 'skills'),
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
    runtimeAgentHomePath: path.join(sessionRoot, 'claude-home'),
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

export const prepareClaudeTryRuntime = async (options: {
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
  const runtimeClaudeHomePath = path.join(finalDirectory, 'claude-home');
  const skillRoot = path.join(workspacePath, '.claude', 'skills');
  const realHome = path.resolve(options.homeDir ?? os.homedir());
  const realClaudeHome = resolveUserClaudeHome({
    homeDir: realHome,
    ...(options.env ? { env: options.env } : {}),
  });
  let finalOwned = false;
  try {
    await assertClaudeTryIsolation({
      runtimeRoot,
      sessionRoot: finalDirectory,
      workspacePath,
      runtimeHomePath,
      runtimeClaudeHomePath,
      skillRoot,
      realHome,
      realClaudeHome,
    });
    await secureDirectory(runtimeRoot);
    await mkdir(finalDirectory, { recursive: false, mode: 0o700 });
    finalOwned = true;
    if (process.platform !== 'win32') await chmod(finalDirectory, 0o700);
    await secureDirectory(runtimeHomePath);
    await secureDirectory(runtimeClaudeHomePath);
    await mkdir(skillRoot, { recursive: true });
    const bridgedFiles = await bridgeClaudeRuntimeState({
      sourceClaudeHome: realClaudeHome,
      runtimeClaudeHome: runtimeClaudeHomePath,
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
      agent: 'claude',
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      ownerPid: options.ownerPid ?? process.pid,
      source: { type: 'local-stack', displayName: options.trial.stackName },
      runtimeRootPath: runtimeRoot,
      workspacePath,
      runtimeHomePath,
      runtimeAgentHomePath: runtimeClaudeHomePath,
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
        throw new TryRuntimeCleanupFailedError('Claude', {
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
      'The isolated Claude trial runtime could not be prepared.',
      { cause: error },
    );
  }
};

export const cleanupClaudeTryRuntime = async (
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
  const expectedClaudeHome = path.join(directory, 'claude-home');
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
      right: expectedClaudeHome,
    }));
  if (!sessionPathsValid)
    throw new TryRuntimeCleanupFailedError('Claude', {
      cause: new Error(
        'Runtime paths are outside the owned session directory.',
      ),
    });
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { cleaned: true };
    throw new TryRuntimeCleanupFailedError('Claude', { cause: error });
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
      { left: marker.runtimeAgentHomePath ?? '', right: expectedClaudeHome },
    ])
      if (!(await pathsEqual(pair)))
        throw new Error('Runtime marker does not match the requested session.');
  } catch (error) {
    throw new TryRuntimeCleanupFailedError('Claude', { cause: error });
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
    { name: 'agent-home', path: expectedClaudeHome },
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

export const recoverStaleClaudeTryRuntimes = async (
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
    if (marker.agent !== 'claude') continue;
    if (marker.status !== 'cleanup-failed') continue;
    if (marker.sessionId !== entry.name) continue;
    scanned += 1;
    try {
      const outcome = await cleanupClaudeTryRuntime({
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

export const launchClaudeTryRuntime = async (options: {
  stackHome: string;
  preparation: TryPreparationResult;
  detection: AgentDetection;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  cleanup?: TryCleanupControls;
}): Promise<TryExitResult> => {
  const session = options.preparation.session;
  const runtimeClaudeHomePath = session.runtimeAgentHomePath ?? '';
  const root = path.parse(session.runtimeHomePath).root;
  const childEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    HOME: session.runtimeHomePath,
    USERPROFILE: session.runtimeHomePath,
    CLAUDE_CONFIG_DIR: runtimeClaudeHomePath,
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
    const inheritedEnvironment = options.env ?? process.env;
    const realHome = path.resolve(
      inheritedEnvironment.HOME ??
        inheritedEnvironment.USERPROFILE ??
        os.homedir(),
    );
    const realClaudeHome = resolveUserClaudeHome({
      homeDir: realHome,
      env: inheritedEnvironment,
    });
    await assertClaudeTryIsolation({
      runtimeRoot: path.resolve(options.stackHome, 'runtime'),
      sessionRoot: path.dirname(session.workspacePath),
      workspacePath: session.workspacePath,
      runtimeHomePath: session.runtimeHomePath,
      runtimeClaudeHomePath,
      skillRoot: path.join(session.workspacePath, '.claude', 'skills'),
      realHome,
      realClaudeHome,
    });
    isolationVerified = true;
    await writeSession(path.dirname(session.workspacePath), {
      ...session,
      status: 'running',
    });
    const result = await launchAgent({
      agent: 'claude',
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
    cleanupOutcome = await cleanupClaudeTryRuntime({
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

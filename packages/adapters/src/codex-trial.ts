import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
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

import { isSafeCodexSkillName, launchCodex } from './codex.js';
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

const bridgeNames = (names: string[]) =>
  names.filter(
    (name) =>
      name === 'config.toml' ||
      name === 'auth.json' ||
      (name.endsWith('.config.toml') &&
        !name.includes('/') &&
        !name.includes('\\')),
  );

// Top-level Codex config tables never carried into an isolated Skill trial.
// A trial only needs auth + basic launch/model settings; personal plugin
// marketplace sources trigger background Git refresh/clone work inside the
// temporary CODEX_HOME (which keeps the disposable runtime alive), and startup
// hooks can spawn arbitrary background processes. Excluding these is isolation,
// not a config-portability feature.
const excludedConfigTables = new Set([
  'marketplaces',
  'marketplace',
  'plugins',
  'plugin',
  'hooks',
]);
const configTableRootSegment = (header: string): string =>
  (header.split('.')[0] ?? '').trim().replace(/^["']|["']$/g, '');
const configKeyName = (line: string): string | undefined => {
  const match = line.match(/^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/);
  if (!match?.[1]) return undefined;
  return match[1].replace(/^["']|["']$/g, '');
};

/**
 * Strip personal plugin/marketplace/hook configuration from a bridged Codex
 * `config.toml` while preserving every other key and table verbatim. Removes
 * whole tables and array-of-tables whose top-level segment is excluded
 * (`[plugins]`, `[plugins.x]`, `[[marketplaces]]`, `[hooks]`, …) and any
 * root-scope bare assignment of an excluded key (`plugins = [...]`). Bytes
 * outside those tables — including comments, ordering, and auth/model settings —
 * are left untouched. The user's real config file is never modified.
 */
export const sanitizeCodexConfigToml = (text: string): string => {
  const tableHeader = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;
  let currentRoot: string | null = null;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(tableHeader);
    if (header) {
      currentRoot = configTableRootSegment(header[1] ?? '');
      if (!excludedConfigTables.has(currentRoot.toLowerCase())) kept.push(line);
      continue;
    }
    if (
      currentRoot !== null &&
      excludedConfigTables.has(currentRoot.toLowerCase())
    )
      continue;
    if (currentRoot === null) {
      const key = configKeyName(line);
      if (key && excludedConfigTables.has(key.toLowerCase())) continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
};
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
    throw new TryAuthBridgeFailedError('Codex', { cause: error });
  }
  const copied: string[] = [];
  try {
    for (const name of bridgeNames(names)) {
      const source = path.join(options.sourceCodexHome, name);
      if (!(await lstat(source)).isFile()) continue;
      const target = path.join(options.runtimeCodexHome, name);
      // TOML config is sanitized (personal plugin/marketplace/hook tables
      // removed); auth.json and other files are copied verbatim.
      if (name.endsWith('.toml')) {
        await writeFile(
          target,
          sanitizeCodexConfigToml(await readFile(source, 'utf8')),
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
    throw new TryAuthBridgeFailedError('Codex', { cause: error });
  }
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
      left: options.session.runtimeCodexHomePath ?? '',
      right: expected.runtimeCodexHomePath,
    },
  ])
    if (!(await pathsEqual(pair))) throw new UnsafeRuntimePathError();
  await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: sessionRoot });
  const marker = await readSessionMarker(sessionRoot);
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
        throw new TryRuntimeCleanupFailedError('Codex', {
          cause: cleanupError,
        });
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

export const cleanupCodexTryRuntime = async (
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
  const expectedCodexHome = path.join(directory, 'codex-home');
  const remove = options.removeEntry ?? defaultRemoveRuntimeEntry;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const settleDelayMs = options.settleDelayMs ?? 250;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => new Date());

  // --- Safety gate: refuse to touch anything we cannot prove we own. ---
  // These are hard refusals (unknown/forged/outside runtime) and still throw.
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
      left: session.runtimeCodexHomePath ?? '',
      right: expectedCodexHome,
    }));
  if (!sessionPathsValid)
    throw new TryRuntimeCleanupFailedError('Codex', {
      cause: new Error(
        'Runtime paths are outside the owned session directory.',
      ),
    });
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { cleaned: true };
    throw new TryRuntimeCleanupFailedError('Codex', { cause: error });
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
      { left: marker.runtimeCodexHomePath ?? '', right: expectedCodexHome },
    ])
      if (!(await pathsEqual(pair)))
        throw new Error('Runtime marker does not match the requested session.');
  } catch (error) {
    throw new TryRuntimeCleanupFailedError('Codex', { cause: error });
  }

  // --- Marker-last cleanup. Owned-child delete failures do NOT throw: they
  // preserve the marker and return a `cleanup-failed` outcome for safe retry. ---
  const recordFailure = async (
    component: TryCleanupComponent,
    error: unknown,
  ): Promise<TryCleanupOutcome> => {
    const diagnostic: TryCleanupDiagnostic = safeCleanupDiagnostic(
      component,
      error,
      now,
    );
    // Marker is preserved (still provably Stack-owned); only safe metadata added.
    await writeSession(directory, {
      ...marker,
      status: 'cleanup-failed',
      cleanup: diagnostic,
    }).catch(() => undefined);
    return { cleaned: false, diagnostic, runtimePath: directory };
  };

  // Signal cleanup-in-progress while the trusted marker is still present.
  await writeSession(directory, { ...marker, status: 'cleaning' });

  // Small bounded grace period so a just-closed child's short-lived background
  // descendants can release handles before the first delete attempt.
  if (settleDelayMs > 0) await sleep(settleDelayMs);

  const components: Array<{ name: TryCleanupComponent; path: string }> = [
    { name: 'workspace', path: expectedWorkspace },
    { name: 'home', path: expectedHome },
    { name: 'codex-home', path: expectedCodexHome },
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

  // Only the ownership marker (and our own atomic-write temp files) may remain.
  // Any unexpected entry is left in place rather than silently deleted.
  let residual: string[];
  try {
    residual = await readdir(directory);
  } catch (error) {
    return recordFailure('session-root', error);
  }
  if (residual.some((name) => !isOwnedMetadataEntry(name)))
    return recordFailure('unexpected-entry', { code: 'EEXIST' });

  // Remove the marker LAST (after any stray temp), then the now-empty root.
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

export type TryRecoveryResult = {
  scanned: number;
  cleaned: number;
  retained: number;
};

/**
 * Before a new trial, conservatively retry cleanup of prior runtimes left in
 * `cleanup-failed` (e.g. a background descendant briefly held the runtime). Only
 * session roots that carry a valid Stack marker with status `cleanup-failed`,
 * whose id matches the directory, are considered; `cleanupCodexTryRuntime` then
 * re-validates containment/paths and performs marker-last cleanup. Unmarked,
 * corrupt, forged, non-`cleanup-failed`, or outside-root directories are never
 * touched, and nothing is force-terminated. Fully best-effort: any per-runtime
 * error is swallowed so recovery can never block a new trial.
 */
export const recoverStaleTryRuntimes = async (
  options: { stackHome: string } & TryCleanupControls,
): Promise<TryRecoveryResult> => {
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
      continue; // unmarked / corrupt / forged — never touch
    }
    if (marker.agent !== 'codex') continue;
    if (marker.status !== 'cleanup-failed') continue;
    if (marker.sessionId !== entry.name) continue;
    scanned += 1;
    try {
      const outcome = await cleanupCodexTryRuntime({
        ...options,
        session: marker,
      });
      if (outcome.cleaned) cleaned += 1;
      else retained += 1;
    } catch {
      retained += 1; // safety refusal or unexpected error — leave it in place
    }
  }
  return { scanned, cleaned, retained };
};

export const launchCodexTryRuntime = async (options: {
  stackHome: string;
  preparation: TryPreparationResult;
  detection: AgentDetection;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  cleanup?: TryCleanupControls;
}): Promise<TryExitResult> => {
  const session = options.preparation.session;
  const root = path.parse(session.runtimeHomePath).root;
  const childEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    HOME: session.runtimeHomePath,
    USERPROFILE: session.runtimeHomePath,
    CODEX_HOME: session.runtimeCodexHomePath ?? '',
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
      runtimeCodexHomePath: session.runtimeCodexHomePath ?? '',
      skillRoot: path.join(session.workspacePath, '.agents', 'skills'),
      realHome,
      realCodexHome,
    });
    isolationVerified = true;
    await writeSession(path.dirname(session.workspacePath), {
      ...session,
      status: 'running',
    });
    // launchCodex resolves on the child `close` lifecycle (shim-safe,
    // shell:false), so cleanup below only begins once the interactive child and
    // its inherited stdio are fully closed — not on an earlier `exit`.
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
    launchError = error;
    if (isolationVerified)
      await writeSession(path.dirname(session.workspacePath), {
        ...session,
        status: 'failed',
      }).catch(() => undefined);
  }
  // Clean up whenever we established ownership — for zero exits, non-zero exits,
  // and launch failures alike. A safety refusal (unknown/forged/outside runtime)
  // still throws; an owned-child delete failure returns a cleanup-failed outcome.
  let cleanupOutcome: TryCleanupOutcome = { cleaned: true };
  if (ownershipVerified)
    cleanupOutcome = await cleanupCodexTryRuntime({
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

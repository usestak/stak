import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertPathWithin, hashSkillDirectory } from '@stack/shared';
import { referenceRecordSchema } from '@stack/spec';
import type { ReferenceRecord } from '@stack/spec';
import { ReferenceRestoreFailedError } from '@stack/cloud-client';
import { ingestSkill } from '@stack/store';

export type GitCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
export type GitExecutor = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<GitCommandResult>;

/** Default Git executor: shell:false, non-interactive, argument arrays only. */
export const spawnGit: GitExecutor = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

const exists = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

export type RestoreReferenceOptions = {
  stackHome: string;
  reference: ReferenceRecord;
  gitExecutor?: GitExecutor;
  now?: () => Date;
};

/**
 * Reacquire the exact Skill referenced by a Git remote+revision+path, verify it
 * hashes to the expected content, and ingest it into the immutable Store. Uses
 * the user's existing Git authentication non-interactively; never collects,
 * stores, or uploads credentials. Exact restoration only — no ref fallback.
 */
export const restoreReference = async (
  options: RestoreReferenceOptions,
): Promise<{ contentHash: string; reused: boolean }> => {
  const reference = referenceRecordSchema.parse(options.reference);
  const git = options.gitExecutor ?? spawnGit;
  const workRoot = path.join(options.stackHome, 'runtime', 'reacquire');
  const workDir = path.join(workRoot, randomUUID());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ADVICE_DETACHED_HEAD: '0',
  };
  const run = async (args: string[]) => {
    let result: GitCommandResult;
    try {
      result = await git(args, { cwd: workDir, env });
    } catch (error) {
      throw new ReferenceRestoreFailedError(
        `git ${args[0]} could not run for ${reference.remote}.`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0)
      throw new ReferenceRestoreFailedError(
        `git ${args[0]} failed for ${reference.remote}@${reference.revision}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    return result;
  };
  try {
    await mkdir(workDir, { recursive: true });
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', reference.remote]);
    await run(['fetch', '--depth', '1', 'origin', reference.revision]);
    await run(['checkout', '-q', '--detach', 'FETCH_HEAD']);

    const skillDir = await assertPathWithin({
      ownedRoot: workDir,
      proposedPath: path.resolve(workDir, ...reference.path.split('/')),
    });
    if (!(await exists(skillDir)) || !(await stat(skillDir)).isDirectory())
      throw new ReferenceRestoreFailedError(
        `Reference path ${reference.path} is missing at ${reference.remote}@${reference.revision}.`,
      );
    const actual = (await hashSkillDirectory(skillDir)).hash;
    if (actual !== reference.expectedContentHash)
      throw new ReferenceRestoreFailedError(
        `Reference ${reference.remote}@${reference.revision}:${reference.path} hashes to ${actual}, expected ${reference.expectedContentHash}.`,
      );
    const ingested = await ingestSkill({
      stackHome: options.stackHome,
      sourcePath: skillDir,
      expectedContentHash: reference.expectedContentHash,
      ...(options.now ? { now: options.now } : {}),
    });
    return { contentHash: ingested.contentHash, reused: ingested.reused };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

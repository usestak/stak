import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SkillSource } from '@stack/spec';

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout.trim();
};

export const detectProvenance = async (
  directory: string,
): Promise<SkillSource> => {
  try {
    const repository = await git(directory, ['rev-parse', '--show-toplevel']);
    const revision = await git(directory, ['rev-parse', 'HEAD']);
    let remote: string | undefined;
    try {
      remote = await git(directory, ['config', '--get', 'remote.origin.url']);
    } catch {
      remote = undefined;
    }
    // The SOURCE LOCATOR: the fully-qualified ref the checkout is on (e.g.
    // `refs/heads/release`). On a detached HEAD / exact-commit checkout this fails and we omit
    // `ref`, which marks the source as exact-commit-pinned (not update-trackable).
    let ref: string | undefined;
    try {
      ref = await git(directory, ['symbolic-ref', '-q', 'HEAD']);
      if (ref.length === 0) ref = undefined;
    } catch {
      ref = undefined;
    }
    const sourcePath =
      path.relative(repository, directory).split(path.sep).join('/') || '.';
    const clean =
      (await git(repository, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        sourcePath,
      ])) === '';
    return {
      type: 'git',
      revision,
      path: sourcePath,
      clean,
      ...(remote ? { remote } : {}),
      ...(ref ? { ref } : {}),
    };
  } catch {
    return { type: 'local' };
  }
};

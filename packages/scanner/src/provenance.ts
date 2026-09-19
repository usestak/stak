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
    return remote
      ? { type: 'git', remote, revision, path: sourcePath, clean }
      : { type: 'git', revision, path: sourcePath, clean };
  } catch {
    return { type: 'local' };
  }
};

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
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

/**
 * Whether `directory` itself has a `.git` entry (file or directory — a worktree/submodule
 * uses a `.git` FILE, a normal repo a `.git` directory; either marks it as a repository
 * root). Cached per directory and meant to be shared across an entire scan: most Skill
 * locations share long common ancestor chains (a global root, home, …) that would otherwise
 * be re-`stat`'d once per Skill location instead of once per directory.
 */
const hasGitEntry = async (
  directory: string,
  cache: Map<string, boolean>,
): Promise<boolean> => {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;
  let found: boolean;
  try {
    await stat(path.join(directory, '.git'));
    found = true;
  } catch {
    found = false;
  }
  cache.set(directory, found);
  return found;
};

/**
 * Cheap pure-JS stand-in for what `git rev-parse --show-toplevel` would answer with NO —
 * walks up from `directory` checking for a `.git` entry — used purely as a fast negative
 * check to skip the `git` subprocess entirely for the overwhelmingly common case (a Skill
 * installed outside any Git working tree, e.g. via a plugin marketplace; see the scanner's
 * real-world finding that 0 of 31 Skills on a typical account are Git-backed). A positive
 * match does NOT short-circuit anything further: the `git` subprocess path below still runs
 * in full, so every Git-specific edge case (worktrees, `core.worktree` overrides, submodules,
 * `safe.directory`) stays exactly as authoritative as it always was — this only ever skips
 * spawning `git` when it's confident the answer would be "not a repository".
 */
const hasGitAncestor = async (
  directory: string,
  cache: Map<string, boolean>,
): Promise<boolean> => {
  let current = directory;
  for (;;) {
    if (await hasGitEntry(current, cache)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

export const detectProvenance = async (
  directory: string,
  ancestorCache: Map<string, boolean> = new Map(),
): Promise<SkillSource> => {
  if (!(await hasGitAncestor(directory, ancestorCache)))
    return { type: 'local' };
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

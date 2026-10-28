import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addGitExcludeEntries,
  addGitExcludeEntry,
  defaultGitRunner,
  excludeEntryFor,
  GitExcludeError,
  GitUnavailableError,
  isIgnoredByGit,
  isTrackedByGit,
  locateGitRepository,
  removeGitExcludeEntries,
  removeGitExcludeEntry,
  resolveGitExcludePath,
  STAK_EXCLUDE_BEGIN,
  STAK_EXCLUDE_END,
  withExcludeEntry,
  withoutExcludeEntry,
  type GitRunner,
} from './git-exclude.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const temp = async (): Promise<string> => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), 'stak-xagent-git-')),
  );
  directories.push(directory);
  return directory;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const initRepo = async (): Promise<string> => {
  const repo = await temp();
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Stak Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'README.md'), 'readme\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'init');
  return repo;
};

describe('exclude block text', () => {
  it('appends a marked block once and is idempotent', () => {
    const user = '# my own\n*.log\n';
    const once = withExcludeEntry(user, '/AGENTS.override.md');
    expect(once).toBe(
      `${user}${STAK_EXCLUDE_BEGIN}\n/AGENTS.override.md\n${STAK_EXCLUDE_END}\n`,
    );
    expect(withExcludeEntry(once, '/AGENTS.override.md')).toBe(once);
  });

  it('adds a second entry inside the same block, sorted', () => {
    const text = withExcludeEntry(
      withExcludeEntry('', '/AGENTS.override.md'),
      '/.cursor/rules/stak-memory.mdc',
    );
    expect(text).toBe(
      `${STAK_EXCLUDE_BEGIN}\n/.cursor/rules/stak-memory.mdc\n/AGENTS.override.md\n${STAK_EXCLUDE_END}\n`,
    );
  });

  it('adds a newline before the block when the user file lacks one', () => {
    expect(withExcludeEntry('*.log', '/a')).toBe(
      `*.log\n${STAK_EXCLUDE_BEGIN}\n/a\n${STAK_EXCLUDE_END}\n`,
    );
  });

  it('removes one entry, then the whole block when it becomes empty', () => {
    const user = '# keep me\r\n*.tmp\r\n';
    const both = withExcludeEntry(withExcludeEntry(user, '/a'), '/b');
    const one = withoutExcludeEntry(both, '/a');
    expect(one).toBe(`${user}${STAK_EXCLUDE_BEGIN}\n/b\n${STAK_EXCLUDE_END}\n`);
    expect(withoutExcludeEntry(one, '/b')).toBe(user);
    expect(withoutExcludeEntry(user, '/b')).toBe(user);
  });

  it('leaves a user line identical to an entry alone when outside the block', () => {
    const user = '/AGENTS.override.md\n';
    const added = withExcludeEntry(user, '/AGENTS.override.md');
    expect(withoutExcludeEntry(added, '/AGENTS.override.md')).toBe(user);
  });

  it('refuses a malformed block', () => {
    expect(() => withExcludeEntry(`${STAK_EXCLUDE_BEGIN}\n/a\n`, '/b')).toThrow(
      GitExcludeError,
    );
    expect(() => withoutExcludeEntry(`${STAK_EXCLUDE_END}\n`, '/b')).toThrow(
      GitExcludeError,
    );
  });

  it('root-anchors and escapes entries', () => {
    expect(excludeEntryFor('AGENTS.override.md')).toBe('/AGENTS.override.md');
    expect(excludeEntryFor('sub dir/[x]*?/a.md')).toBe(
      '/sub dir/\\[x\\]\\*\\?/a.md',
    );
    expect(excludeEntryFor('trailing ')).toBe('/trailing\\ ');
  });
});

describe('a fake GitRunner', () => {
  it('reports git as unavailable', async () => {
    const missing: GitRunner = {
      run: () => Promise.reject(new GitUnavailableError()),
    };
    expect(await locateGitRepository(missing, await temp())).toEqual({
      kind: 'no-git',
    });
  });

  it('resolves a relative --git-path against the directory', async () => {
    const dir = await temp();
    const fake: GitRunner = {
      run: (_cwd, args) =>
        Promise.resolve(
          args.join(' ') === 'rev-parse --git-path info/exclude'
            ? { exitCode: 0, stdout: '.git/info/exclude\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: '' },
        ),
    };
    expect(await resolveGitExcludePath(fake, dir)).toBe(
      path.join(dir, '.git', 'info', 'exclude'),
    );
  });
});

describe.skipIf(!hasGit)('with a real Git repository', () => {
  it('locates a repository and a plain folder', async () => {
    const repo = await initRepo();
    const location = await locateGitRepository(defaultGitRunner, repo);
    expect(location.kind).toBe('repo');
    if (location.kind !== 'repo') return;
    expect(await realpath(location.toplevel)).toBe(repo);
    expect(location.excludePath).toBe(
      path.join(repo, '.git', 'info', 'exclude'),
    );
    expect(
      (await locateGitRepository(defaultGitRunner, await temp())).kind,
    ).toBe('not-repo');
  });

  it('writes the block once, hides the file, and removes it cleanly', async () => {
    const repo = await initRepo();
    const exclude = await resolveGitExcludePath(defaultGitRunner, repo);
    await rm(path.dirname(exclude), { recursive: true, force: true }); // info/ missing
    await addGitExcludeEntry(exclude, '/AGENTS.override.md');
    await addGitExcludeEntry(exclude, '/AGENTS.override.md');
    const text = await readFile(exclude, 'utf8');
    expect(text.split(STAK_EXCLUDE_BEGIN).length).toBe(2);

    await writeFile(path.join(repo, 'AGENTS.override.md'), 'private\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    await removeGitExcludeEntry(exclude, '/AGENTS.override.md');
    expect(await readFile(exclude, 'utf8')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain('AGENTS.override.md');
  });

  it("keeps the user's own exclude lines untouched", async () => {
    const repo = await initRepo();
    const exclude = await resolveGitExcludePath(defaultGitRunner, repo);
    await mkdir(path.dirname(exclude), { recursive: true });
    const user =
      '# git ls-files --others --exclude-from=.git/info/exclude\n*.local\n';
    await writeFile(exclude, user);
    await addGitExcludeEntry(exclude, '/AGENTS.override.md');
    await removeGitExcludeEntry(exclude, '/AGENTS.override.md');
    expect(await readFile(exclude, 'utf8')).toBe(user);
  });

  it('resolves --git-path for a worktree to the shared exclude file', async () => {
    const repo = await initRepo();
    const worktree = path.join(await temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    const exclude = await resolveGitExcludePath(defaultGitRunner, worktree);
    expect(exclude).toBe(path.join(repo, '.git', 'info', 'exclude'));
    await addGitExcludeEntry(exclude, '/AGENTS.override.md');
    await writeFile(path.join(worktree, 'AGENTS.override.md'), 'private\n');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    git(repo, 'worktree', 'remove', '--force', worktree);
  });

  it('detects a tracked file', async () => {
    const repo = await initRepo();
    expect(await isTrackedByGit(defaultGitRunner, repo, 'README.md')).toBe(
      true,
    );
    expect(
      await isTrackedByGit(defaultGitRunner, repo, 'AGENTS.override.md'),
    ).toBe(false);
  });

  it('reports whether a path is ignored', async () => {
    const repo = await initRepo();
    const exclude = await resolveGitExcludePath(defaultGitRunner, repo);
    await addGitExcludeEntry(exclude, '/AGENTS.override.md');
    expect(
      await isIgnoredByGit(defaultGitRunner, repo, 'AGENTS.override.md'),
    ).toBe(true);
    expect(await isIgnoredByGit(defaultGitRunner, repo, 'other.md')).toBe(
      false,
    );
  });
});

describe('fail-closed Git answers', () => {
  const answering = (exitCode: number): GitRunner => ({
    run: () => Promise.resolve({ exitCode, stdout: '', stderr: '' }),
  });

  it('isTrackedByGit: 0 tracked, 1 untracked, anything else throws', async () => {
    const dir = await temp();
    expect(await isTrackedByGit(answering(0), dir, 'a')).toBe(true);
    expect(await isTrackedByGit(answering(1), dir, 'a')).toBe(false);
    await expect(isTrackedByGit(answering(128), dir, 'a')).rejects.toThrow(
      GitExcludeError,
    );
  });

  it('isIgnoredByGit: 0 ignored, 1 not ignored, anything else throws', async () => {
    const dir = await temp();
    expect(await isIgnoredByGit(answering(0), dir, 'a')).toBe(true);
    expect(await isIgnoredByGit(answering(1), dir, 'a')).toBe(false);
    await expect(isIgnoredByGit(answering(128), dir, 'a')).rejects.toThrow(
      GitExcludeError,
    );
  });

  it('adds and removes several entries in one rewrite', async () => {
    const file = path.join(await temp(), 'info', 'exclude');
    await addGitExcludeEntries(file, ['/b', '/a']);
    expect(await readFile(file, 'utf8')).toBe(
      `${STAK_EXCLUDE_BEGIN}\n/a\n/b\n${STAK_EXCLUDE_END}\n`,
    );
    await removeGitExcludeEntries(file, ['/a', '/b']);
    expect(await readFile(file, 'utf8')).toBe('');
  });
});

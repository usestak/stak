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
  agentExportPaths,
  guardPrivateProjectFile,
  readExportState,
  releasePrivateProjectFile,
} from './exporter.js';
import {
  defaultGitRunner,
  GitUnavailableError,
  STAK_EXCLUDE_BEGIN,
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
    await mkdtemp(path.join(tmpdir(), 'stak-private-file-')),
  );
  directories.push(directory);
  return directory;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const initRepo = async (files: Record<string, string> = {}) => {
  const repo = await temp();
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Stak Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'README.md'), 'readme\n');
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(repo, name), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return repo;
};

const excludeText = async (repo: string): Promise<string> => {
  try {
    return await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  } catch {
    return '';
  }
};

const guard = (stackHome: string, projectDir: string, git?: GitRunner) =>
  guardPrivateProjectFile({
    stackHome,
    projectDir,
    relativePath: 'CLAUDE.local.md',
    ...(git ? { git } : {}),
  });

describe('guardPrivateProjectFile: a repository Git refuses vs. no usable Git', () => {
  /** A folder with a `.git` entry, so it is a repository whatever Git says. */
  const repoFolder = async () => {
    const dir = await temp();
    await mkdir(path.join(dir, '.git'));
    return dir;
  };

  it('Git refuses the repository (safe.directory): not written, with the safe.directory hint', async () => {
    const home = await temp();
    const dir = await repoFolder();
    const refusing: GitRunner = {
      run: async () => ({
        exitCode: 128,
        stdout: '',
        stderr: `fatal: detected dubious ownership in repository at '${dir}'`,
      }),
    };
    const result = await guard(home, dir, refusing);
    expect(result).toEqual({
      write: false,
      status: 'skipped-no-git',
      message: `CLAUDE.local.md was not written: Git refused to read this repository (for example its safe.directory ownership check), so STAK can't keep your private instructions out of it. If you trust it, run \`git config --global --add safe.directory ${dir}\`.`,
    });
  });

  it('Git is not installed: not written, and says so', async () => {
    const home = await temp();
    const dir = await repoFolder();
    const missing: GitRunner = {
      run: () => Promise.reject(new GitUnavailableError()),
    };
    const result = await guard(home, dir, missing);
    expect(result).toEqual({
      write: false,
      status: 'skipped-no-git',
      message:
        "CLAUDE.local.md was not written: Git isn't installed or can't be started, so STAK can't keep your private instructions out of this repository.",
    });
  });
});

describe.skipIf(!hasGit)('guardPrivateProjectFile (CLAUDE.local.md)', () => {
  it('not ignored: adds the root-anchored file and temp lines, Git then ignores it, and the record is kept', async () => {
    const home = await temp();
    const repo = await initRepo();
    expect(await guard(home, repo)).toEqual({
      write: true,
      status: 'excluded',
    });
    const exclude = await excludeText(repo);
    expect(exclude).toContain(STAK_EXCLUDE_BEGIN);
    expect(exclude).toContain('/CLAUDE.local.md\n');
    expect(exclude).toContain('/.CLAUDE.local.md.*.tmp\n');
    await writeFile(path.join(repo, 'CLAUDE.local.md'), 'private\n');
    expect(git(repo, 'status', '--porcelain', '-uall')).toBe('');
    expect((await readExportState(home)).privateFiles).toEqual([
      expect.objectContaining({ path: path.join(repo, 'CLAUDE.local.md') }),
    ]);
    // Again: nothing more to add, still written.
    expect((await guard(home, repo)).write).toBe(true);
  });

  it('a project in a subfolder of the repository is anchored from the repository root', async () => {
    const home = await temp();
    const repo = await initRepo();
    const sub = path.join(repo, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    expect((await guard(home, sub)).status).toBe('excluded');
    expect(await excludeText(repo)).toContain(
      '/packages/app/CLAUDE.local.md\n',
    );
  });

  it('already ignored by the repository: no extra line', async () => {
    const home = await temp();
    const repo = await initRepo({
      '.gitignore': 'CLAUDE.local.md\n.CLAUDE.local.md.*.tmp\n',
    });
    expect(await guard(home, repo)).toEqual({
      write: true,
      status: 'ignored',
    });
    expect(await excludeText(repo)).not.toContain(STAK_EXCLUDE_BEGIN);
    expect((await readExportState(home)).privateFiles).toBeUndefined();
  });

  it('only the file is ignored: only the temp line is added', async () => {
    const home = await temp();
    const repo = await initRepo({ '.gitignore': 'CLAUDE.local.md\n' });
    expect((await guard(home, repo)).status).toBe('excluded');
    const exclude = await excludeText(repo);
    expect(exclude).toContain('/.CLAUDE.local.md.*.tmp\n');
    expect(exclude).not.toContain('/CLAUDE.local.md\n');
  });

  it('tracked: the user commits it on purpose, so it is written with no exclude', async () => {
    const home = await temp();
    const repo = await initRepo({ 'CLAUDE.local.md': 'team-visible\n' });
    expect(await guard(home, repo)).toEqual({
      write: true,
      status: 'tracked',
    });
    expect(await excludeText(repo)).not.toContain(STAK_EXCLUDE_BEGIN);
  });

  it('re-included by a .gitignore "!" rule: not written, with a note, and no STAK line is left', async () => {
    const home = await temp();
    const repo = await initRepo({ '.gitignore': '!CLAUDE.local.md\n' });
    const result = await guard(home, repo);
    expect(result).toEqual({
      write: false,
      status: 'skipped-not-ignorable',
      message:
        'CLAUDE.local.md was not written: this repository\'s .gitignore re-includes it (a "!" rule), so STAK can\'t keep your private instructions out of Git.',
    });
    expect(await excludeText(repo)).not.toContain('CLAUDE.local.md');
    expect((await readExportState(home)).privateFiles).toBeUndefined();
  });

  it('a Git error: not written, with a note', async () => {
    const home = await temp();
    const repo = await initRepo();
    const failing: GitRunner = {
      run: async (cwd, args) =>
        args[0] === 'ls-files'
          ? { exitCode: 128, stdout: '', stderr: 'fatal: broken index' }
          : defaultGitRunner.run(cwd, args),
    };
    const result = await guard(home, repo, failing);
    expect(result.write).toBe(false);
    expect(result).toMatchObject({ status: 'failed' });
    if (!result.write)
      expect(result.message).toMatch(
        /^CLAUDE\.local\.md was not written: .*STAK can't confirm it would stay out of Git\.$/,
      );
  });

  it('a corrupt state.json: not written, and the note names the file and the recovery', async () => {
    const home = await temp();
    const repo = await initRepo();
    const statePath = agentExportPaths(home).state;
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{ broken');
    const result = await guard(home, repo);
    expect(result).toEqual({
      write: false,
      status: 'failed',
      message: `CLAUDE.local.md was not written: STAK's record of the files it keeps out of Git (${statePath}) is unreadable. Move it aside (e.g. state.json.bak), then run \`stak pull\` (or \`stak memory materialize\`).`,
    });
    expect(await excludeText(repo)).not.toContain('CLAUDE.local.md');
  });

  it('not a Git repository: written as before, nothing recorded', async () => {
    const home = await temp();
    const dir = await temp();
    expect(await guard(home, dir)).toEqual({ write: true, status: 'plain' });
    expect((await readExportState(home)).privateFiles).toBeUndefined();
  });

  it('release drops the record and its lines, but keeps a line another worktree still uses', async () => {
    const home = await temp();
    const repo = await initRepo();
    const worktree = path.join(await temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt');

    expect((await guard(home, repo)).status).toBe('excluded');
    expect((await guard(home, worktree)).status).toBe('excluded');
    await releasePrivateProjectFile({
      stackHome: home,
      projectDir: repo,
      relativePath: 'CLAUDE.local.md',
    });
    // The worktree's copy still relies on the shared line.
    expect(await excludeText(repo)).toContain('/CLAUDE.local.md\n');
    await releasePrivateProjectFile({
      stackHome: home,
      projectDir: worktree,
      relativePath: 'CLAUDE.local.md',
    });
    expect(await excludeText(repo)).not.toContain('CLAUDE.local.md');
    expect((await readExportState(home)).privateFiles).toEqual([]);
  });
});

/** Final-review hardening: crashed temp files (I3), Windows path casing (M1)
 * and Git location variables in STAK's environment (M2). */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  exportProjectMemory,
  readExportState,
  removeProjectExport,
} from './exporter.js';
import {
  defaultGitRunner,
  gitChildEnv,
  locateGitRepository,
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
    await mkdtemp(path.join(tmpdir(), 'stak-xagent-hard-')),
  );
  directories.push(directory);
  return directory;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const initRepo = async () => {
  const repo = await temp();
  git(repo, 'init', '-q');
  return repo;
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const documents = [{ path: 'notes/MEMORY.md', text: 'a note' }];
const exportCodex = (stackHome: string, projectDir: string) =>
  exportProjectMemory({
    stackHome,
    projectId: 'prj_hardening',
    projectDir,
    agent: 'codex',
    documents,
  });
const excludeOf = (repo: string) =>
  readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

describe.skipIf(!hasGit)(
  'I3: crashed temp files never become committable',
  () => {
    it("removal deletes STAK's leftover temp siblings before releasing the temp line", async () => {
      const home = await temp();
      const repo = await initRepo();
      expect((await exportCodex(home, repo)).status).toBe('written');
      const crashed = path.join(
        repo,
        `.AGENTS.override.md.${randomUUID()}.tmp`,
      );
      await writeFile(crashed, 'half-written');
      const unrelated = path.join(repo, '.AGENTS.override.md.notes.tmp');
      await writeFile(unrelated, "not STAK's");

      expect(
        (
          await removeProjectExport({
            stackHome: home,
            projectId: 'prj_hardening',
            projectDir: repo,
            agent: 'codex',
          })
        ).status,
      ).toBe('removed');
      expect(await exists(crashed)).toBe(false);
      expect(await exists(unrelated)).toBe(true);
      expect(await excludeOf(repo)).not.toContain('AGENTS.override.md');
    });

    it('a temp sibling STAK cannot delete keeps the temp line in place', async () => {
      const home = await temp();
      const repo = await initRepo();
      await exportCodex(home, repo);
      // A directory with a temp-file name: not STAK's file to delete.
      const stuck = path.join(repo, `.AGENTS.override.md.${randomUUID()}.tmp`);
      await mkdir(stuck);
      await writeFile(path.join(stuck, 'x'), 'x');

      await removeProjectExport({
        stackHome: home,
        projectId: 'prj_hardening',
        projectDir: repo,
        agent: 'codex',
      });
      const exclude = await excludeOf(repo);
      expect(exclude).toContain('/.AGENTS.override.md.*.tmp');
      expect(exclude).not.toContain('/AGENTS.override.md\n');
      expect(git(repo, 'status', '--porcelain', '-uall')).toBe('');
    });
  },
);

describe.skipIf(!hasGit || process.platform !== 'win32')(
  'M1: path casing on Windows',
  () => {
    it('the same folder with a different drive-letter case is not a move', async () => {
      const home = await temp();
      const repo = await initRepo();
      const flipped =
        (repo[0] === repo[0]?.toUpperCase()
          ? repo[0]?.toLowerCase()
          : repo[0]?.toUpperCase()) + repo.slice(1);
      expect((await exportCodex(home, repo)).status).toBe('written');
      expect((await exportCodex(home, flipped)).status).toBe('unchanged');
      const state = await readExportState(home);
      expect(state.retired ?? []).toEqual([]);
      expect(await exists(path.join(repo, 'AGENTS.override.md'))).toBe(true);
    });
  },
);

describe('M2: Git location variables never leak into STAK Git calls', () => {
  it('gitChildEnv drops GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR and GIT_PREFIX', () => {
    expect(
      gitChildEnv({
        PATH: '/bin',
        GIT_DIR: '/x/.git',
        GIT_WORK_TREE: '/x',
        GIT_INDEX_FILE: '/x/index',
        GIT_COMMON_DIR: '/x/.git',
        GIT_PREFIX: 'sub/',
        git_dir: '/lower',
        GIT_AUTHOR_NAME: 'kept',
      }),
    ).toEqual({ PATH: '/bin', GIT_AUTHOR_NAME: 'kept' });
  });

  it.skipIf(!hasGit)(
    'with GIT_DIR pointing at another repository, STAK still locates the right one',
    async () => {
      const mine = await initRepo();
      const other = await initRepo();
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(other, '.git');
      try {
        const location = await locateGitRepository(defaultGitRunner, mine);
        expect(location.kind).toBe('repo');
        if (location.kind === 'repo') {
          expect(await realpath(location.toplevel)).toBe(mine);
          expect(path.resolve(location.excludePath)).toBe(
            path.join(mine, '.git', 'info', 'exclude'),
          );
        }
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }
    },
  );
});

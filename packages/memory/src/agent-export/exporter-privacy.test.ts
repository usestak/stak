/** Fix round 1: privacy holes found in review (shared exclude lines, moved
 * folders, `.gitignore` negations, temp files, stranded files, fail-closed Git). */
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentExportTargetOf,
  exportProjectMemory,
  exportStatus,
  readExportState,
  removeProjectExport,
} from './exporter.js';
import { STAK_EXCLUDE_BEGIN, type GitRunner } from './git-exclude.js';
import { MANAGED_LINE, renderAgentMemory } from './render.js';

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
    await mkdtemp(path.join(tmpdir(), 'stak-xagent-priv-')),
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

const status = (cwd: string): string =>
  git(cwd, 'status', '--porcelain', '--untracked-files=all');

const PROJECT = 'prj_0123456789abcdef0123456789abcdef';
const PROJECT_B = 'prj_fedcba9876543210fedcba9876543210';
const docs = [
  { path: 'notes/MEMORY.md', text: '- [Build](build.md)\n' },
  { path: 'notes/build.md', text: 'Run pnpm -w build first.\n' },
];

const listFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
};

/** A fake Git that treats `projectDir` as a repo root with `excludePath`. */
const fakeRepoGit = (
  projectDir: string,
  excludePath: string,
  overrides: {
    lsFiles?: number;
    checkIgnore?: (args: readonly string[]) => Promise<number> | number;
  } = {},
): GitRunner => ({
  run: async (_cwd, args) => {
    const command = args.join(' ');
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
    if (command === 'rev-parse --show-toplevel') return ok(`${projectDir}\n`);
    if (command === 'rev-parse --git-path info/exclude')
      return ok(`${excludePath}\n`);
    if (args[0] === 'ls-files')
      return { exitCode: overrides.lsFiles ?? 1, stdout: '', stderr: '' };
    if (args[0] === 'check-ignore')
      return {
        exitCode: overrides.checkIgnore ? await overrides.checkIgnore(args) : 0,
        stdout: '',
        stderr: '',
      };
    return { exitCode: 2, stdout: '', stderr: `unexpected: ${command}` };
  },
});

describe('ordering and fail-closed Git (fake Git)', () => {
  it('adds the exclude entry, and checks it holds, before the file exists', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const excludePath = path.join(await temp(), 'info', 'exclude');
    const target = agentExportTargetOf(projectDir, 'cursor');
    const seen: string[] = [];
    const fake = fakeRepoGit(projectDir, excludePath, {
      checkIgnore: async (args) => {
        seen.push(String(args.at(-1)));
        // At check time the entry is in place and nothing was written yet.
        expect(await readFile(excludePath, 'utf8')).toContain(
          '/.cursor/rules/stak-memory.mdc',
        );
        expect(await readdir(projectDir)).toEqual([]);
        return 0;
      },
    });
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
      documents: docs,
      git: fake,
    });
    expect(result.status).toBe('written');
    expect(seen[0]).toBe('.cursor/rules/stak-memory.mdc');
    expect(seen[1]).toMatch(/^\.cursor\/rules\/\.stak-memory\.mdc\..+\.tmp$/);
    expect(await readFile(target, 'utf8')).toContain(MANAGED_LINE);
  });

  it('fails closed when git ls-files errors (exit other than 1)', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const excludePath = path.join(await temp(), 'info', 'exclude');
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
      git: fakeRepoGit(projectDir, excludePath, { lsFiles: 128 }),
    });
    expect(result.status).toBe('failed');
    expect(await readdir(projectDir)).toEqual([]);
  });

  it('fails closed when git check-ignore errors', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const excludePath = path.join(await temp(), 'info', 'exclude');
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
      git: fakeRepoGit(projectDir, excludePath, { checkIgnore: () => 128 }),
    });
    expect(result.status).toBe('failed');
    expect(await readdir(projectDir)).toEqual([]);
  });
});

describe('stranded and moved files (no Git repository)', () => {
  it('adopts a stranded file identical to the fresh render', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const target = agentExportTargetOf(projectDir, 'codex');
    // As if a crash happened after the write but before the record.
    await writeFile(
      target,
      renderAgentMemory({ agent: 'codex', documents: docs }).content,
    );
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(result.status).toBe('unchanged');
    expect(
      (await readExportState(stackHome)).projects[PROJECT]?.codex?.path,
    ).toBe(target);
    expect(
      await exportStatus({
        stackHome,
        projectId: PROJECT,
        projectDir,
        agent: 'codex',
      }),
    ).toBe('up-to-date');
  });

  it('deletes the old unchanged file when the project folder moves', async () => {
    const stackHome = await temp();
    const oldDir = await temp();
    const newDir = await temp();
    const base = { stackHome, projectId: PROJECT, agent: 'cursor' } as const;
    await exportProjectMemory({ ...base, projectDir: oldDir, documents: docs });
    const moved = await exportProjectMemory({
      ...base,
      projectDir: newDir,
      documents: docs,
    });
    expect(moved.status).toBe('written');
    expect(await listFiles(oldDir)).toEqual([]);
    const state = await readExportState(stackHome);
    expect(state.projects[PROJECT]?.cursor?.path).toBe(moved.path);
    expect(state.retired ?? []).toEqual([]);
  });

  it('keeps tracking a hand-edited file left at the old folder', async () => {
    const stackHome = await temp();
    const oldDir = await temp();
    const newDir = await temp();
    const base = { stackHome, projectId: PROJECT, agent: 'cursor' } as const;
    const first = await exportProjectMemory({
      ...base,
      projectDir: oldDir,
      documents: docs,
    });
    await writeFile(first.path, 'my edit\n');
    await exportProjectMemory({ ...base, projectDir: newDir, documents: docs });
    expect(await readFile(first.path, 'utf8')).toBe('my edit\n');
    const state = await readExportState(stackHome);
    expect(state.retired?.map((record) => record.path)).toEqual([first.path]);

    // Once the user deletes it, the retired record goes on the next run.
    await rm(first.path);
    await exportProjectMemory({ ...base, projectDir: newDir, documents: docs });
    expect((await readExportState(stackHome)).retired ?? []).toEqual([]);
  });
});

describe.skipIf(!hasGit)('privacy in a real Git repository', () => {
  it('keeps a worktree file ignored after removing the export for main', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    const worktree = path.join(await temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    for (const [projectId, projectDir] of [
      [PROJECT_B, worktree],
      [PROJECT, repo],
    ] as const) {
      const result = await exportProjectMemory({
        stackHome,
        projectId,
        projectDir,
        agent: 'codex',
        documents: docs,
      });
      expect(result.status).toBe('written');
    }
    expect(
      await removeProjectExport({
        stackHome,
        projectId: PROJECT,
        projectDir: repo,
        agent: 'codex',
      }),
    ).toEqual({ status: 'removed' });
    expect(status(worktree)).toBe('');

    await removeProjectExport({
      stackHome,
      projectId: PROJECT_B,
      projectDir: worktree,
      agent: 'codex',
    });
    expect(
      await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).not.toContain(STAK_EXCLUDE_BEGIN);
    git(repo, 'worktree', 'remove', '--force', worktree);
  });

  it('refuses when a .gitignore negation re-includes the file', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    await writeFile(
      path.join(repo, '.gitignore'),
      '.cursor/rules/*\n!.cursor/rules/*.mdc\n',
    );
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'gitignore');
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir: repo,
      agent: 'cursor',
      documents: docs,
    });
    expect(result.status).toBe('skipped-not-ignorable');
    expect(result.message).toContain('.gitignore');
    expect(await listFiles(repo)).not.toContain(
      '.cursor/rules/stak-memory.mdc',
    );
    expect(
      await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).not.toContain(STAK_EXCLUDE_BEGIN);
    expect(status(repo)).toBe('');
    expect(
      (await readExportState(stackHome)).projects[PROJECT],
    ).toBeUndefined();
  });

  it('withdraws its own file once a .gitignore negation appears later', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir: repo,
      agent: 'cursor',
    } as const;
    const first = await exportProjectMemory({ ...base, documents: docs });
    expect(first.status).toBe('written');
    await writeFile(path.join(repo, '.gitignore'), '!.cursor/rules/*.mdc\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'gitignore');
    const again = await exportProjectMemory({ ...base, documents: docs });
    expect(again.status).toBe('skipped-not-ignorable');
    expect(await listFiles(repo)).not.toContain(
      '.cursor/rules/stak-memory.mdc',
    );
    expect(status(repo)).toBe('');
  });

  it('keeps the exclude entry when disabling leaves a hand-edited file', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir: repo,
      agent: 'codex',
    } as const;
    const { path: target } = await exportProjectMemory({
      ...base,
      documents: docs,
    });
    await writeFile(target, 'hand edit\n');
    expect(await removeProjectExport(base)).toEqual({
      status: 'kept-hand-edited',
    });
    expect(status(repo)).toBe('');
  });

  it('keeps a hand-edited file at the old folder excluded after a move', async () => {
    const stackHome = await temp();
    const oldRepo = await initRepo();
    const newDir = await temp();
    const base = { stackHome, projectId: PROJECT, agent: 'codex' } as const;
    const first = await exportProjectMemory({
      ...base,
      projectDir: oldRepo,
      documents: docs,
    });
    await writeFile(first.path, 'edited\n');
    await exportProjectMemory({ ...base, projectDir: newDir, documents: docs });
    expect(await removeProjectExport({ ...base, projectDir: newDir })).toEqual({
      status: 'kept-hand-edited',
    });
    expect(await readFile(first.path, 'utf8')).toBe('edited\n');
    expect(status(oldRepo)).toBe('');
  });

  it('restores the retired record when the project moves back', async () => {
    const stackHome = await temp();
    const dirA = await initRepo();
    const dirB = await temp();
    const base = { stackHome, projectId: PROJECT, agent: 'codex' } as const;
    const first = await exportProjectMemory({
      ...base,
      projectDir: dirA,
      documents: docs,
    });
    expect(first.status).toBe('written');
    await writeFile(first.path, 'hand edit in A\n');
    expect(
      (
        await exportProjectMemory({
          ...base,
          projectDir: dirB,
          documents: docs,
        })
      ).status,
    ).toBe('written');

    const back = await exportProjectMemory({
      ...base,
      projectDir: dirA,
      documents: docs,
    });
    expect(back.status).toBe('skipped-hand-edited');
    expect(await readFile(first.path, 'utf8')).toBe('hand edit in A\n');
    expect(await exportStatus({ ...base, projectDir: dirA })).toBe(
      'hand-edited',
    );
    const state = await readExportState(stackHome);
    expect(state.projects[PROJECT]?.codex?.path).toBe(first.path);
    expect(state.retired ?? []).toEqual([]); // B's unchanged file was swept
    expect(await listFiles(dirB)).toEqual([]);
    expect(status(dirA)).toBe('');

    const reset = await exportProjectMemory({
      ...base,
      projectDir: dirA,
      documents: docs,
      overwriteHandEdits: true,
    });
    expect(reset.status).toBe('written');
    expect(await readFile(first.path, 'utf8')).toContain(MANAGED_LINE);
    expect(await exportStatus({ ...base, projectDir: dirA })).toBe(
      'up-to-date',
    );
    expect(status(dirA)).toBe('');
  });

  it('works inside a submodule', async () => {
    const stackHome = await temp();
    const inner = await initRepo();
    const outer = await initRepo();
    git(
      outer,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(outer, 'commit', '-qm', 'add submodule');
    const sub = path.join(outer, 'sub');
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir: sub,
      agent: 'cursor',
      documents: docs,
    });
    expect(result.status).toBe('written');
    expect(status(sub)).toBe('');
    expect(status(outer)).toBe('');
    expect(
      await readFile(
        path.join(outer, '.git', 'modules', 'sub', 'info', 'exclude'),
        'utf8',
      ),
    ).toContain('/.cursor/rules/stak-memory.mdc');
  });
});

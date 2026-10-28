import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashBytes } from '../store.js';
import {
  agentExportPaths,
  agentExportTargetOf,
  exportProjectMemory,
  exportStatus,
  readExportSettings,
  readExportState,
  removeProjectExport,
  writeExportSettings,
} from './exporter.js';
import {
  GitUnavailableError,
  STAK_EXCLUDE_BEGIN,
  type GitRunner,
} from './git-exclude.js';
import {
  CODEX_BUDGET_BYTES,
  MANAGED_LINE,
  renderAgentMemory,
} from './render.js';

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
    await mkdtemp(path.join(tmpdir(), 'stak-xagent-exp-')),
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

const PROJECT = 'prj_0123456789abcdef0123456789abcdef';
const docs = [
  { path: 'notes/MEMORY.md', text: '- [Build](build.md)\n' },
  { path: 'notes/build.md', text: 'Run pnpm -w build first.\n' },
  { path: 'instructions/private.md', text: 'Be terse.\n' },
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

describe('exportProjectMemory (no Git repository)', () => {
  it('writes the rendered file, records state, then reports unchanged', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const first = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
      now: () => new Date('2026-10-28T10:00:00.000Z'),
    });
    const target = path.join(projectDir, 'AGENTS.override.md');
    expect(first).toEqual({ status: 'written', path: target, omitted: [] });
    const bytes = await readFile(target);
    expect(bytes.toString('utf8')).toBe(
      renderAgentMemory({ agent: 'codex', documents: docs }).content,
    );
    const state = await readExportState(stackHome);
    expect(state.projects[PROJECT]?.codex).toEqual({
      path: target,
      sha256: hashBytes(bytes),
      agentsMdHash: null,
      updatedAt: '2026-10-28T10:00:00.000Z',
    });
    expect(
      await exportStatus({
        stackHome,
        projectId: PROJECT,
        projectDir,
        agent: 'codex',
      }),
    ).toBe('up-to-date');

    const second = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(second.status).toBe('unchanged');
    // No .git was created and no exclude was written anywhere.
    expect(await listFiles(projectDir)).toEqual(['AGENTS.override.md']);
  });

  it('writes the Cursor rule under .cursor/rules', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
      documents: docs,
    });
    expect(result.status).toBe('written');
    expect(result.path).toBe(
      path.join(projectDir, '.cursor', 'rules', 'stak-memory.mdc'),
    );
    expect(await readFile(result.path, 'utf8')).toMatch(
      /^---\ndescription: "Project memory from STAK"\nalwaysApply: true\n---\n/,
    );
  });

  it("skips the user's own AGENTS.override.md and never touches it", async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const target = path.join(projectDir, 'AGENTS.override.md');
    await writeFile(target, 'mine\n');
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(result.status).toBe('skipped-user-file');
    expect(result.message).toBeDefined();
    expect(await readFile(target, 'utf8')).toBe('mine\n');
    expect(
      await exportStatus({
        stackHome,
        projectId: PROJECT,
        projectDir,
        agent: 'codex',
      }),
    ).toBe('user-file');
    expect(
      await removeProjectExport({
        stackHome,
        projectId: PROJECT,
        projectDir,
        agent: 'codex',
      }),
    ).toEqual({ status: 'none' });
    expect(await readFile(target, 'utf8')).toBe('mine\n');
  });

  it('does not overwrite a hand edit, unless asked to reset', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
    } as const;
    const { path: target } = await exportProjectMemory({
      ...base,
      documents: docs,
    });
    await writeFile(target, 'edited by hand\n');
    expect(await exportStatus(base)).toBe('hand-edited');

    const changed = [...docs, { path: 'notes/new.md', text: 'new' }];
    const skipped = await exportProjectMemory({ ...base, documents: changed });
    expect(skipped.status).toBe('skipped-hand-edited');
    expect(skipped.message).toContain('stak memory agents reset cursor');
    expect(await readFile(target, 'utf8')).toBe('edited by hand\n');

    const reset = await exportProjectMemory({
      ...base,
      documents: changed,
      overwriteHandEdits: true,
    });
    expect(reset.status).toBe('written');
    expect(await readFile(target, 'utf8')).toContain('## notes/new.md');
  });

  it('rewrites the Codex file when the team AGENTS.md changes (stale before)', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
    } as const;
    await writeFile(path.join(projectDir, 'AGENTS.md'), '# Team v1\n');
    const first = await exportProjectMemory({ ...base, documents: docs });
    expect(await readFile(first.path, 'utf8')).toMatch(
      new RegExp(
        `^# Team v1\\n\\n---\\n\\n${MANAGED_LINE.replace(/[.*?`]/g, '\\$&')}`,
      ),
    );
    expect(
      (await readExportState(stackHome)).projects[PROJECT]?.codex?.agentsMdHash,
    ).toBe(hashBytes(Buffer.from('# Team v1\n')));

    await writeFile(path.join(projectDir, 'AGENTS.md'), '# Team v2\n');
    expect(await exportStatus(base)).toBe('stale');
    const second = await exportProjectMemory({ ...base, documents: docs });
    expect(second.status).toBe('written');
    expect(await readFile(second.path, 'utf8')).toContain('# Team v2');
    expect(await exportStatus(base)).toBe('up-to-date');
  });

  it('reports stale when given Memory that differs from what was written', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
    } as const;
    expect(await exportStatus(base)).toBe('missing');
    await exportProjectMemory({ ...base, documents: docs });
    expect(await exportStatus({ ...base, documents: docs })).toBe('up-to-date');
    expect(
      await exportStatus({
        ...base,
        documents: [{ path: 'notes/x.md', text: 'x' }],
      }),
    ).toBe('stale');
  });

  it('skips an oversized team AGENTS.md and withdraws its own old override', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
    } as const;
    const first = await exportProjectMemory({ ...base, documents: docs });
    expect(first.status).toBe('written');
    await writeFile(
      path.join(projectDir, 'AGENTS.md'),
      'T'.repeat(CODEX_BUDGET_BYTES + 1),
    );
    const result = await exportProjectMemory({ ...base, documents: docs });
    expect(result.status).toBe('skipped-team-too-large');
    expect(result.message).toBeDefined();
    expect(await listFiles(projectDir)).toEqual(['AGENTS.md']);
    expect(
      (await readExportState(stackHome)).projects[PROJECT]?.codex,
    ).toBeUndefined();
  });

  it('removes only an unchanged STAK file', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const base = {
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
    } as const;
    expect(await removeProjectExport(base)).toEqual({ status: 'none' });

    const { path: target } = await exportProjectMemory({
      ...base,
      documents: docs,
    });
    await writeFile(target, 'hand edit\n');
    expect(await removeProjectExport(base)).toEqual({
      status: 'kept-hand-edited',
    });
    expect(await readFile(target, 'utf8')).toBe('hand edit\n');

    await exportProjectMemory({
      ...base,
      documents: docs,
      overwriteHandEdits: true,
    });
    expect(await removeProjectExport(base)).toEqual({ status: 'removed' });
    expect(await listFiles(projectDir)).toEqual([]);
    expect(
      (await readExportState(stackHome)).projects[PROJECT]?.cursor,
    ).toBeUndefined();
  });

  it('keeps all of its state under memory/agent-exports', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    for (const agent of ['codex', 'cursor'] as const) {
      await exportProjectMemory({
        stackHome,
        projectId: PROJECT,
        projectDir,
        agent,
        documents: docs,
      });
    }
    await writeExportSettings(stackHome, { enabled: { codex: true } });
    await removeProjectExport({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
    });
    expect(await listFiles(stackHome)).toEqual([
      'memory/agent-exports/settings.json',
      'memory/agent-exports/state.json',
    ]);
    expect(agentExportPaths(stackHome).root).toBe(
      path.join(stackHome, 'memory', 'agent-exports'),
    );
  });

  it('fails (without throwing) for a missing project folder or corrupt state', async () => {
    const stackHome = await temp();
    const projectDir = path.join(await temp(), 'gone');
    const missing = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(missing.status).toBe('failed');

    const realDir = await temp();
    await mkdir(agentExportPaths(stackHome).root, { recursive: true });
    await writeFile(agentExportPaths(stackHome).state, '{not json');
    const corrupt = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir: realDir,
      agent: 'codex',
      documents: docs,
    });
    expect(corrupt.status).toBe('failed');
    expect(await listFiles(realDir)).toEqual([]);
  });

  it('refuses to follow a symlinked .cursor folder', async (context) => {
    const stackHome = await temp();
    const projectDir = await temp();
    const outside = await temp();
    try {
      await symlink(outside, path.join(projectDir, '.cursor'), 'junction');
    } catch {
      context.skip();
    }
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
      documents: docs,
    });
    expect(result.status).toBe('failed');
    expect(await listFiles(outside)).toEqual([]);
  });

  it('refuses to follow a symlink at the target file', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const outsideDir = await temp();
    const outside = path.join(outsideDir, 'elsewhere.md');
    await writeFile(outside, 'outside\n');
    const link = path.join(projectDir, 'AGENTS.override.md');
    try {
      await symlink(outside, link, 'file');
    } catch {
      // Windows without symlink rights: a junction is also a link at the target.
      await symlink(outsideDir, link, 'junction');
    }
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(result.status).toBe('failed');
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });
});

describe('exportProjectMemory without Git available', () => {
  const noGit: GitRunner = {
    run: () => Promise.reject(new GitUnavailableError()),
  };

  it('does not write into a Git repository it cannot check', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    await mkdir(path.join(projectDir, '.git'));
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
      git: noGit,
    });
    expect(result.status).toBe('skipped-no-git');
    expect(result.message).toBeDefined();
    expect(await readdir(projectDir)).toEqual(['.git']);
  });

  it('still writes into a plain folder', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
      git: noGit,
    });
    expect(result.status).toBe('written');
  });

  it('treats a folder Git refuses to read as unverifiable', async () => {
    const stackHome = await temp();
    const projectDir = await temp();
    await mkdir(path.join(projectDir, '.git'));
    const refusing: GitRunner = {
      run: () =>
        Promise.resolve({
          exitCode: 128,
          stdout: '',
          stderr: 'dubious ownership',
        }),
    };
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'cursor',
      documents: docs,
      git: refusing,
    });
    expect(result.status).toBe('skipped-no-git');
  });
});

describe.skipIf(!hasGit)('exportProjectMemory in a real Git repository', () => {
  it('excludes the file before writing it, and keeps git status clean', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    for (const agent of ['codex', 'cursor'] as const) {
      const result = await exportProjectMemory({
        stackHome,
        projectId: PROJECT,
        projectDir: repo,
        agent,
        documents: docs,
      });
      expect(result.status).toBe('written');
    }
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
    const exclude = await readFile(
      path.join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude).toContain(
      `${STAK_EXCLUDE_BEGIN}\n/.cursor/rules/stak-memory.mdc\n/AGENTS.override.md\n# <<< STAK <<<\n`,
    );
    expect(exclude.split(STAK_EXCLUDE_BEGIN).length).toBe(2);

    const again = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir: repo,
      agent: 'codex',
      documents: docs,
    });
    expect(again.status).toBe('unchanged');

    // Disable both: files and block are gone, the user's exclude text remains.
    for (const agent of ['codex', 'cursor'] as const) {
      expect(
        await removeProjectExport({
          stackHome,
          projectId: PROJECT,
          projectDir: repo,
          agent,
        }),
      ).toEqual({ status: 'removed' });
    }
    const after = await readFile(
      path.join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(after).not.toContain(STAK_EXCLUDE_BEGIN);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
  });

  it('anchors the entry at the repository root for a project in a subfolder', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    const projectDir = path.join(repo, 'apps', 'web');
    await mkdir(projectDir, { recursive: true });
    await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir,
      agent: 'codex',
      documents: docs,
    });
    expect(
      await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('\n/apps/web/AGENTS.override.md\n');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
  });

  it('works in a linked worktree', async () => {
    const stackHome = await temp();
    const repo = await initRepo();
    const worktree = path.join(await temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    const result = await exportProjectMemory({
      stackHome,
      projectId: PROJECT,
      projectDir: worktree,
      agent: 'cursor',
      documents: docs,
    });
    expect(result.status).toBe('written');
    expect(
      git(worktree, 'status', '--porcelain', '--untracked-files=all'),
    ).toBe('');
    expect(
      await removeProjectExport({
        stackHome,
        projectId: PROJECT,
        projectDir: worktree,
        agent: 'cursor',
      }),
    ).toEqual({ status: 'removed' });
    git(repo, 'worktree', 'remove', '--force', worktree);
  });

  it('never writes a file Git already tracks', async () => {
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
    git(repo, 'add', '-f', 'AGENTS.override.md');
    git(repo, 'commit', '-qm', 'oops');
    const before = await readFile(target, 'utf8');
    const result = await exportProjectMemory({
      ...base,
      documents: [...docs, { path: 'notes/more.md', text: 'more' }],
    });
    expect(result.status).toBe('skipped-tracked');
    expect(result.message).toBeDefined();
    expect(await readFile(target, 'utf8')).toBe(before);
  });
});

describe('export settings', () => {
  it('defaults to nothing enabled and round-trips', async () => {
    const stackHome = await temp();
    expect(await readExportSettings(stackHome)).toEqual({ enabled: {} });
    await writeExportSettings(stackHome, {
      enabled: { cursor: true, codex: false },
    });
    expect(await readExportSettings(stackHome)).toEqual({
      enabled: { cursor: true, codex: false },
    });
  });

  it('targets the agreed file names', () => {
    expect(agentExportTargetOf('/p', 'codex')).toBe(
      path.join('/p', 'AGENTS.override.md'),
    );
    expect(agentExportTargetOf('/p', 'cursor')).toBe(
      path.join('/p', '.cursor', 'rules', 'stak-memory.mdc'),
    );
  });
});

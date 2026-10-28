import { execFileSync } from 'node:child_process';
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentExportPaths,
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalGitIdentity,
  hashBytes,
  writeCanonicalMain,
  writeMemoryObject,
  defaultGitRunner,
  type GitRunner,
  encodeClaudeProjectKey,
  fileLocalMemoryKeyStore,
  inMemoryRemoteMemoryBackend,
  InMemoryRemoteMemoryStore,
  readExportSettings,
  readLocalRegistry,
  resolveOrMintProject,
  setBinding,
  writeExportSettings,
  writeLocalRegistry,
  type BackupResult,
} from '@stack/memory';

import {
  agentMemoryStatus,
  disableAgentMemory,
  enableAgentMemory,
  exportAgentMemory,
  resetAgentMemory,
} from './agent-export-ops.js';
import {
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageCanonicalMemory,
} from './canonical-ops.js';
import {
  agentMemoryStatusLines,
  renderAgentDisable,
  renderAgentExportNotes,
} from '../ui/agent-memory.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let stackHome: string;
let claudeHome: string;
let projectDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'stak-xagent-cli-')));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  projectDir = path.join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const codexFile = (dir: string) => path.join(dir, 'AGENTS.override.md');
const cursorFile = (dir: string) =>
  path.join(dir, '.cursor', 'rules', 'stak-memory.mdc');

const bindProject = async (dir: string, home = stackHome) => {
  let registry = await readLocalRegistry(home);
  const minted = resolveOrMintProject(registry, {
    kind: 'local',
    vendorKey: `v-${path.basename(dir)}`,
  });
  registry = setBinding(minted.registry, {
    projectId: minted.projectId,
    dir,
    boundAt: '2026-10-28T00:00:00.000Z',
    provenance: 'user-map',
  });
  await writeLocalRegistry(home, registry);
  return minted.projectId;
};

const writeNote = async (dir: string, body: string, home = claudeHome) => {
  const memoryDir = path.join(
    home,
    'projects',
    encodeClaudeProjectKey(path.resolve(dir)),
    'memory',
  );
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path.join(memoryDir, 'MEMORY.md'), body, 'utf8');
};

/** A bound project with one note and private instructions, staged into STAK. */
const stagedProject = async (dir = projectDir, note = 'use pnpm') => {
  const projectId = await bindProject(dir);
  await writeNote(dir, note);
  await writeFile(path.join(dir, 'CLAUDE.local.md'), 'be brief', 'utf8');
  await stageCanonicalMemory(stackHome, { claudeHome });
  return projectId;
};

const discovery = () => ({ claudeHome });

describe('enable / refresh (spec §7 On, Fresh)', () => {
  it('enable codex turns sharing on and writes AGENTS.override.md with the Memory; Cursor stays untouched', async () => {
    await stagedProject();
    const report = await enableAgentMemory(stackHome, discovery(), 'codex');

    expect(report.problems).toEqual([]);
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]).toMatchObject({ agent: 'codex', written: 1 });
    const text = await readFile(codexFile(projectDir), 'utf8');
    expect(text).toContain('use pnpm');
    expect(text).toContain('be brief');
    expect((await readExportSettings(stackHome)).enabled).toEqual({
      codex: true,
    });
    expect(await exists(cursorFile(projectDir))).toBe(false);
    expect(renderAgentExportNotes(report, 'enable')).toBe(
      'Codex: memory shared with 1 project.\n',
    );
  });

  it('a refresh after a Memory change rewrites the enabled agent only; a disabled agent is never written', async () => {
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');

    await writeNote(projectDir, 'use pnpm, never npm');
    await stageCanonicalMemory(stackHome, { claudeHome });
    const report = await exportAgentMemory(stackHome, discovery());

    expect(report.agents.map((a) => a.agent)).toEqual(['codex']);
    expect(report.agents[0]?.written).toBe(1);
    expect(await readFile(codexFile(projectDir), 'utf8')).toContain(
      'never npm',
    );
    expect(await exists(cursorFile(projectDir))).toBe(false);
    expect(renderAgentExportNotes(report)).toBe(
      'Codex: memory updated for 1 project.\n',
    );
    // Nothing changed: silent.
    expect(
      renderAgentExportNotes(await exportAgentMemory(stackHome, discovery())),
    ).toBe('');
  });

  it('with no agent enabled, a refresh writes nothing and says nothing', async () => {
    await stagedProject();
    const report = await exportAgentMemory(stackHome, discovery());
    expect(report).toEqual({ agents: [], problems: [] });
    expect(await exists(codexFile(projectDir))).toBe(false);
    expect(await exists(cursorFile(projectDir))).toBe(false);
  });

  it('exports present notes/** and instructions/private.md only: never agents/** or a deleted note', async () => {
    const projectId = await bindProject(projectDir);
    const doc = async (docPath: string, text: string) => {
      const bytes = Buffer.from(text, 'utf8');
      const contentHash = hashBytes(bytes);
      await writeMemoryObject({ stackHome, contentHash, bytes });
      return {
        path: docPath,
        state: 'present' as const,
        contentHash,
        importedFrom: 'claude' as const,
        importedAt: '2026-10-28T00:00:00.000Z',
      };
    };
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId,
          documents: [
            await doc('notes/MEMORY.md', 'shared note'),
            await doc('instructions/private.md', 'private instructions'),
            await doc('agents/claude/reviewer.md', 'claude-only agent'),
            {
              path: 'notes/old.md',
              state: 'deleted',
              lastContentHash: hashBytes(Buffer.from('gone note', 'utf8')),
              deletedAt: '2026-10-28T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    await enableAgentMemory(stackHome, discovery(), 'cursor');
    const text = await readFile(cursorFile(projectDir), 'utf8');
    expect(text).toContain('shared note');
    expect(text).toContain('private instructions');
    expect(text).not.toContain('claude-only agent');
    expect(text).not.toContain('agents/claude');
    expect(text).not.toContain('notes/old.md');
  });

  it('a project with no shareable Memory gets no file', async () => {
    await bindProject(projectDir);
    const report = await enableAgentMemory(stackHome, discovery(), 'cursor');
    expect(report.agents[0]).toMatchObject({ written: 0, unchanged: 0 });
    expect(await exists(cursorFile(projectDir))).toBe(false);
  });
});

describe('one folder per project per run', () => {
  it('a project found in two folders (two checkouts of one repo) is skipped with a note, and neither folder is written', async () => {
    const gitRemote = 'https://github.com/acme/twice.git';
    const identity = canonicalGitIdentity(gitRemote);
    if (!identity) throw new Error('test setup: no git identity');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeNote(first, 'shared note');
    await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: first, gitRemote }],
    });
    await writeExportSettings(stackHome, { enabled: { codex: true } });

    // A later run sees both checkouts (and no Claude folder for either), so
    // the project is located by its Git claim in two folders.
    const report = await exportAgentMemory(stackHome, {
      claudeHome: path.join(root, 'empty-claude'),
      projects: [
        { dir: first, gitRemote },
        { dir: second, gitRemote },
      ],
    });

    expect(report.agents[0]?.written).toBe(0);
    expect(report.agents[0]?.skipped).toEqual([
      expect.objectContaining({ status: 'skipped-ambiguous' }),
    ]);
    expect(await exists(codexFile(first))).toBe(false);
    expect(await exists(codexFile(second))).toBe(false);
    expect(renderAgentExportNotes(report)).toMatch(
      /^Codex: .+ skipped — found in more than one folder \(.*first.*second.*\)\. Choose one with `stak project map .+ <dir>`\.\n$/,
    );

    // With only one checkout visible, it is written there.
    const single = await exportAgentMemory(stackHome, {
      claudeHome: path.join(root, 'empty-claude'),
      projects: [{ dir: first, gitRemote }],
    });
    expect(single.agents[0]?.written).toBe(1);
    expect(await exists(codexFile(first))).toBe(true);
  });
});

describe('status (spec §7 Status)', () => {
  it('up to date, then out of date after a Memory change, then hand-edited', async () => {
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    let status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents.find((a) => a.agent === 'codex')).toMatchObject({
      enabled: true,
      projects: 1,
      upToDate: 1,
    });
    expect(status.agents.find((a) => a.agent === 'cursor')?.enabled).toBe(
      false,
    );
    expect(agentMemoryStatusLines(status)).toEqual([
      '',
      'Agent memory',
      '  Codex    up to date (1 project)',
    ]);

    await writeNote(projectDir, 'changed note');
    await stageCanonicalMemory(stackHome, { claudeHome });
    status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents[0]).toMatchObject({ outOfDate: 1, upToDate: 0 });
    expect(agentMemoryStatusLines(status)[2]).toBe(
      '  Codex    1 out of date of 1 project',
    );

    await exportAgentMemory(stackHome, discovery());
    await writeFile(codexFile(projectDir), 'my own edit\n', 'utf8');
    status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents[0]).toMatchObject({ handEdited: 1 });
    expect(status.agents[0]?.details[0]?.message).toContain(
      'stak memory agents reset codex',
    );
  });

  it('no enabled agent: no status lines', async () => {
    await stagedProject();
    expect(
      agentMemoryStatusLines(await agentMemoryStatus(stackHome, discovery())),
    ).toEqual([]);
  });
});

describe('disable / reset', () => {
  it('disable removes the unchanged file and clears the setting', async () => {
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'cursor');
    expect(await exists(cursorFile(projectDir))).toBe(true);

    const report = await disableAgentMemory(stackHome, 'cursor');
    expect(report).toMatchObject({ removed: 1, kept: [], problems: [] });
    expect(await exists(cursorFile(projectDir))).toBe(false);
    expect((await readExportSettings(stackHome)).enabled).toEqual({});
    expect(renderAgentDisable(report)).toBe(
      'Cursor: memory sharing is off. Removed .cursor/rules/stak-memory.mdc from 1 project.\n',
    );
  });

  it('reset rewrites a hand-edited STAK file; a refresh does not', async () => {
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    await writeFile(codexFile(projectDir), 'hand edit\n', 'utf8');

    const refresh = await exportAgentMemory(stackHome, discovery());
    expect(refresh.agents[0]?.skipped[0]?.status).toBe('skipped-hand-edited');
    // A refresh after add/pull/push stays quiet about it…
    expect(renderAgentExportNotes(refresh)).toBe('');
    // …but enable (and `stak run`) says how to fix it.
    const again = await enableAgentMemory(stackHome, discovery(), 'codex');
    expect(renderAgentExportNotes(again, 'enable')).toContain(
      '; not overwritten. Move the edit into your memory, or run `stak memory agents reset codex`.',
    );
    expect(await readFile(codexFile(projectDir), 'utf8')).toBe('hand edit\n');

    const reset = await resetAgentMemory(stackHome, discovery(), 'codex');
    expect(reset).toMatchObject({ enabled: true });
    expect(reset.agents[0]?.written).toBe(1);
    expect(await readFile(codexFile(projectDir), 'utf8')).toContain('use pnpm');
  });

  it('reset of an agent that is off does nothing', async () => {
    await stagedProject();
    const reset = await resetAgentMemory(stackHome, discovery(), 'codex');
    expect(reset).toEqual({ enabled: false, agents: [], problems: [] });
    expect(await exists(codexFile(projectDir))).toBe(false);
  });
});

describe('a corrupt state file never throws (spec §8)', () => {
  it('export, status and disable return the recovery note', async () => {
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    const statePath = agentExportPaths(stackHome).state;
    await writeFile(statePath, '{ not json', 'utf8');

    const exported = await exportAgentMemory(stackHome, discovery());
    expect(exported.agents).toEqual([]);
    expect(exported.problems).toEqual([
      {
        code: 'state-corrupt',
        message: `Agent memory sharing skipped: STAK's record of the agent files it wrote is unreadable. Move ${statePath} aside (for example, rename it to state.json.bak), then run \`stak memory agents reset codex\` and check \`git status\` in your projects.`,
      },
    ]);
    const status = await agentMemoryStatus(stackHome, discovery());
    expect(status.problems[0]?.code).toBe('state-corrupt');
    const disabled = await disableAgentMemory(stackHome, 'codex');
    expect(disabled.problems[0]?.code).toBe('state-corrupt');
    // The setting was still cleared (privacy first: nothing writes again).
    expect((await readExportSettings(stackHome)).enabled).toEqual({});
  });

  it('corrupt settings give their own note', async () => {
    await stagedProject();
    await mkdir(agentExportPaths(stackHome).root, { recursive: true });
    await writeFile(agentExportPaths(stackHome).settings, '[]', 'utf8');
    const report = await enableAgentMemory(stackHome, discovery(), 'cursor');
    expect(report.problems[0]?.code).toBe('settings-corrupt');
    expect(report.problems[0]?.message).toContain(
      'stak memory agents enable cursor',
    );
    expect(await exists(cursorFile(projectDir))).toBe(false);
  });
});

describe.skipIf(!hasGit)('in a real Git repository', () => {
  const initRepo = (dir: string) => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'core.autocrlf', 'false');
  };

  it('the files are excluded locally and never show in git status', async () => {
    initRepo(projectDir);
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    await enableAgentMemory(stackHome, discovery(), 'cursor');

    expect(await exists(codexFile(projectDir))).toBe(true);
    expect(await exists(cursorFile(projectDir))).toBe(true);
    const exclude = await readFile(
      path.join(projectDir, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude).toContain('/AGENTS.override.md');
    expect(exclude).toContain('/.cursor/rules/stak-memory.mdc');
    const porcelain = git(projectDir, 'status', '--porcelain', '-uall');
    expect(porcelain).not.toContain('AGENTS.override.md');
    expect(porcelain).not.toContain('stak-memory.mdc');
  });

  it('a .gitignore that re-includes the Cursor file: skipped with a note, and reported as not ignorable', async () => {
    initRepo(projectDir);
    await writeFile(
      path.join(projectDir, '.gitignore'),
      '.cursor/rules/*\n!.cursor/rules/*.mdc\n',
      'utf8',
    );
    await stagedProject();
    const report = await enableAgentMemory(stackHome, discovery(), 'cursor');

    expect(report.agents[0]?.skipped[0]?.status).toBe('skipped-not-ignorable');
    expect(await exists(cursorFile(projectDir))).toBe(false);
    expect(renderAgentExportNotes(report, 'enable')).toMatch(
      /^Cursor: memory sharing is on\.\nCursor: 1 project skipped — \.gitignore re-includes \.cursor\/rules\/stak-memory\.mdc, so STAK won't write it \(prj_\w+…\)\.\n$/,
    );
    const status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents[1]).toMatchObject({ notIgnorable: 1, projects: 1 });
    expect(agentMemoryStatusLines(status)[2]).toBe(
      '  Cursor   1 not ignorable of 1 project',
    );
  });

  it('a "!" rule added after STAK wrote its file shows as not ignorable right away', async () => {
    initRepo(projectDir);
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'cursor');
    let status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents[1]).toMatchObject({ upToDate: 1, notIgnorable: 0 });

    await writeFile(
      path.join(projectDir, '.gitignore'),
      '!.cursor/rules/stak-memory.mdc\n',
      'utf8',
    );
    status = await agentMemoryStatus(stackHome, discovery());
    expect(status.agents[1]).toMatchObject({ upToDate: 0, notIgnorable: 1 });
    expect(status.agents[1]?.details[0]?.message).toContain(
      'so Git could commit it',
    );
    expect(agentMemoryStatusLines(status)[2]).toBe(
      '  Cursor   1 not ignorable of 1 project',
    );
  });

  it('a Git error in the status check shows as "couldn\'t check", never as fine', async () => {
    initRepo(projectDir);
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    const failingCheckIgnore: GitRunner = {
      run: async (cwd, args) =>
        args[0] === 'check-ignore'
          ? { exitCode: 128, stdout: '', stderr: 'fatal: broken' }
          : defaultGitRunner.run(cwd, args),
    };
    const status = await agentMemoryStatus(stackHome, discovery(), {
      git: failingCheckIgnore,
    });
    expect(status.agents[0]).toMatchObject({ upToDate: 0, unchecked: 1 });
    expect(status.agents[0]?.details[0]?.message).toMatch(/^couldn't check: /);
    expect(agentMemoryStatusLines(status)[2]).toBe(
      "  Codex    1 couldn't be checked of 1 project",
    );
  });

  it('disable keeps a hand-edited file, still excluded from Git, and says so', async () => {
    initRepo(projectDir);
    await stagedProject();
    await enableAgentMemory(stackHome, discovery(), 'codex');
    await writeFile(codexFile(projectDir), 'my edit\n', 'utf8');

    const report = await disableAgentMemory(stackHome, 'codex');
    expect(report.removed).toBe(0);
    expect(report.kept).toHaveLength(1);
    expect(await readFile(codexFile(projectDir), 'utf8')).toBe('my edit\n');
    expect(git(projectDir, 'status', '--porcelain', '-uall')).not.toContain(
      'AGENTS.override.md',
    );
    expect(renderAgentDisable(report)).toContain(
      'because it was edited by hand. It is still excluded from Git',
    );
  });
});

describe('a second machine pulls and shares the Memory with both agents', () => {
  it('pull, then the refresh, writes Codex and Cursor files for the located project', async () => {
    const gitRemote = 'https://github.com/acme/two-machines.git';
    const keys = (dir: string) =>
      fileLocalMemoryKeyStore(dir, {
        harden: () => Promise.resolve(true),
        verify: () => Promise.resolve(true),
      });
    const backup = (): Promise<BackupResult> =>
      Promise.resolve({
        provider: 'claude',
        files: 0,
        projects: 0,
        createdAt: '2026-10-28T00:00:00.000Z',
      });
    const backend = inMemoryRemoteMemoryBackend(
      new InMemoryRemoteMemoryStore(),
      'xagent-two-machines',
    );

    // Machine A: Claude notes, `stak add .`, `stak push`.
    const homeA = path.join(root, 'a-home');
    const claudeA = path.join(root, 'a-claude');
    const dirA = path.join(root, 'a-proj');
    await mkdir(dirA, { recursive: true });
    await writeNote(dirA, 'note from A', claudeA);
    const discoveryA = {
      claudeHome: claudeA,
      projects: [{ dir: dirA, gitRemote }],
    };
    await stageCanonicalMemory(homeA, discoveryA);
    expect(
      (
        await pushMemoryViaCanonical(
          {
            stackHome: homeA,
            backend,
            localKeyStore: keys(path.join(root, 'a-keys')),
            runLocalBackup: backup,
          },
          discoveryA,
        )
      ).status,
    ).toBe('pushed');

    // Machine B: both agents on, a checkout of the repo, `stak pull`.
    const homeB = path.join(root, 'b-home');
    const dirB = path.join(root, 'b-proj');
    await mkdir(dirB, { recursive: true });
    await writeExportSettings(homeB, {
      enabled: { codex: true, cursor: true },
    });
    const discoveryB = {
      claudeHome: path.join(root, 'b-claude'),
      projects: [{ dir: dirB, gitRemote }],
    };
    expect(
      (
        await pullMemoryViaCanonical(
          {
            stackHome: homeB,
            backend,
            localKeyStore: keys(path.join(root, 'b-keys')),
            runLocalBackup: backup,
          },
          discoveryB,
        )
      ).status,
    ).toBe('merged');
    const report = await exportAgentMemory(homeB, discoveryB);

    expect(report.agents.map((a) => [a.agent, a.written])).toEqual([
      ['codex', 1],
      ['cursor', 1],
    ]);
    expect(await readFile(codexFile(dirB), 'utf8')).toContain('note from A');
    expect(await readFile(cursorFile(dirB), 'utf8')).toContain('note from A');
  });
});

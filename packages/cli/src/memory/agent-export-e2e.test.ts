/**
 * Cross-agent Project Memory end to end (spec 2026-10-28, plan Task 3): two
 * machines, the real functions each command runs, in the order and inside the
 * Memory lock the commands use, and a real Git repository on each machine.
 */
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
  CODEX_SEPARATOR,
  CURSOR_FRONTMATTER,
  encodeClaudeProjectKey,
  fileLocalMemoryKeyStore,
  inMemoryRemoteMemoryBackend,
  InMemoryRemoteMemoryStore,
  MANAGED_LINE,
  readMemoryManifest,
  STAK_EXCLUDE_BEGIN,
  STAK_EXCLUDE_END,
  withMemoryLock,
  type BackupResult,
  type RemoteMemoryBackend,
} from '@stack/memory';

import {
  disableAgentMemory,
  enableAgentMemory,
  exportAgentMemory,
} from './agent-export-ops.js';
import {
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageAllMemory,
  type CanonicalDiscoveryOptions,
} from './canonical-ops.js';
import { runMemoryCloudRecover } from './cloud-ops.js';

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

const gitRemote = 'https://github.com/acme/xagent-e2e.git';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'stak-xagent-e2e-')));
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

/** A checkout of the shared repository at `dir`, with `files` committed. */
const checkout = async (dir: string, files: Record<string, string>) => {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Stak Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'remote', 'add', 'origin', gitRemote);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text, 'utf8');
    git(dir, 'add', name);
  }
  git(dir, 'commit', '-qm', 'init');
};

type Machine = {
  home: string;
  claudeHome: string;
  dir: string;
  deps: {
    stackHome: string;
    backend: RemoteMemoryBackend;
    localKeyStore: ReturnType<typeof fileLocalMemoryKeyStore>;
    runLocalBackup: () => Promise<BackupResult>;
  };
  /** What `memoryDiscoveryOptions()` gives the commands: the checkout as a
   * candidate, with its origin read from Git. */
  discovery: () => CanonicalDiscoveryOptions;
};

const machine = (name: string, dir: string, backend: RemoteMemoryBackend) => {
  const home = path.join(root, `${name}-home`);
  const claudeHome = path.join(root, `${name}-claude`);
  return {
    home,
    claudeHome,
    dir,
    deps: {
      stackHome: home,
      backend,
      localKeyStore: fileLocalMemoryKeyStore(path.join(root, `${name}-keys`), {
        harden: () => Promise.resolve(true),
        verify: () => Promise.resolve(true),
      }),
      runLocalBackup: () =>
        Promise.resolve({
          provider: 'claude' as const,
          files: 0,
          projects: 0,
          createdAt: '2026-10-28T00:00:00.000Z',
        }),
    },
    discovery: () => ({
      claudeHome,
      projects: [
        { dir, gitRemote: git(dir, 'config', '--get', 'remote.origin.url') },
      ],
    }),
  } satisfies Machine;
};

const locked = <T>(m: Machine, command: string, fn: () => Promise<T>) =>
  withMemoryLock(m.home, command, fn, { installSignalHandlers: false });

/** `stak add .`: stage, then refresh the agent files, inside one lock. */
const add = (m: Machine) =>
  locked(m, 'stak add', async () => {
    await stageAllMemory({ stackHome: m.home, ...m.discovery() });
    return exportAgentMemory(m.home, m.discovery());
  });

/** `stak push`'s Memory part. */
const push = (m: Machine) =>
  locked(m, 'stak push', async () => {
    const outcome = await pushMemoryViaCanonical(m.deps, m.discovery());
    await exportAgentMemory(m.home, m.discovery());
    return outcome;
  });

/** `stak pull`'s Memory part: the fresh-machine recover when there is no
 * local Memory yet, the canonical pull, then the agent refresh. */
const pull = (m: Machine) =>
  locked(m, 'stak pull', async () => {
    if (!(await readMemoryManifest(m.home)))
      expect((await runMemoryCloudRecover(m.deps)).status).toBe('recovered');
    const outcome = await pullMemoryViaCanonical(m.deps, m.discovery());
    expect(outcome.status).not.toBe('conflict');
    expect(outcome.unavailable ?? []).toEqual([]);
    return exportAgentMemory(m.home, m.discovery());
  });

const writeClaudeNote = async (m: Machine, file: string, text: string) => {
  const memoryDir = path.join(
    m.claudeHome,
    'projects',
    encodeClaudeProjectKey(path.resolve(m.dir)),
    'memory',
  );
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path.join(memoryDir, file), text, 'utf8');
};

/** Index of each needle in `text`, asserting each is present. */
const positions = (text: string, needles: string[]): number[] =>
  needles.map((needle) => {
    const at = text.indexOf(needle);
    expect(at, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
    return at;
  });

const ascending = (values: number[]) =>
  expect(values).toEqual([...values].sort((a, b) => a - b));

describe.skipIf(!hasGit)(
  'cross-agent Memory across two machines (plan Task 3)',
  () => {
    it('A adds and pushes; B (fresh, same remote, another path) enables both agents and pulls; edits flow; disabling Cursor cleans up', async () => {
      const backend = inMemoryRemoteMemoryBackend(
        new InMemoryRemoteMemoryStore(),
        'xagent-e2e',
      );

      // Machine A: Claude notes plus private instructions, `add .`, `push`.
      const a = machine(
        'a',
        path.join(root, 'machine-a', 'xagent-e2e'),
        backend,
      );
      // No .gitignore anywhere: STAK itself must keep CLAUDE.local.md private.
      await checkout(a.dir, { 'README.md': 'demo\n' });
      await writeClaudeNote(
        a,
        'MEMORY.md',
        '- [Build](build.md): how to build\n',
      );
      await writeClaudeNote(a, 'build.md', 'Build with pnpm.\n');
      await writeFile(
        path.join(a.dir, 'CLAUDE.local.md'),
        'Answer tersely.\n',
        'utf8',
      );
      await add(a);
      expect((await push(a)).status).toBe('pushed');

      // Machine B: a fresh STAK home, the same repository at another path,
      // with the team's AGENTS.md committed.
      const b = machine(
        'b',
        path.join(root, 'machine-b', 'elsewhere', 'xagent-e2e'),
        backend,
      );
      const teamAgentsMd = '# Team rules\n\nRun the tests before pushing.\n';
      await checkout(b.dir, { 'AGENTS.md': teamAgentsMd });
      for (const agent of ['codex', 'cursor'] as const)
        await locked(b, 'stak memory agents enable', () =>
          enableAgentMemory(b.home, b.discovery(), agent),
        );
      const firstPull = await pull(b);
      expect(firstPull.problems).toEqual([]);
      expect(firstPull.agents.map((r) => [r.agent, r.written])).toEqual([
        ['codex', 1],
        ['cursor', 1],
      ]);

      const codexFile = path.join(b.dir, 'AGENTS.override.md');
      const cursorFile = path.join(
        b.dir,
        '.cursor',
        'rules',
        'stak-memory.mdc',
      );
      const codex = await readFile(codexFile, 'utf8');
      const cursor = await readFile(cursorFile, 'utf8');
      // §4.1/§4.3 order: team AGENTS.md, separator, managed line, private
      // instructions, the notes index, then the other notes by path.
      expect(codex.startsWith(teamAgentsMd.trimEnd())).toBe(true);
      ascending(
        positions(codex, [
          'Run the tests before pushing.',
          CODEX_SEPARATOR,
          MANAGED_LINE,
          'instructions/private.md',
          'Answer tersely.',
          'notes/MEMORY.md',
          '- [Build](build.md)',
          'notes/build.md',
          'Build with pnpm.',
        ]),
      );
      expect(cursor.startsWith(CURSOR_FRONTMATTER)).toBe(true);
      expect(cursor).not.toContain('Team rules');
      ascending(
        positions(cursor, [
          MANAGED_LINE,
          'Answer tersely.',
          '- [Build](build.md)',
          'Build with pnpm.',
        ]),
      );

      // Pull also wrote Claude's own private file into the checkout.
      expect(await readFile(path.join(b.dir, 'CLAUDE.local.md'), 'utf8')).toBe(
        'Answer tersely.\n',
      );

      // Private: listed in the local exclude block, invisible to Git.
      const excludeFile = path.join(b.dir, '.git', 'info', 'exclude');
      const exclude = await readFile(excludeFile, 'utf8');
      const [begin, end] = positions(exclude, [
        STAK_EXCLUDE_BEGIN,
        STAK_EXCLUDE_END,
      ]);
      for (const entry of positions(exclude, [
        '/AGENTS.override.md',
        '/.cursor/rules/stak-memory.mdc',
        '/CLAUDE.local.md',
      ])) {
        expect(entry).toBeGreaterThan(begin ?? -1);
        expect(entry).toBeLessThan(end ?? -1);
      }
      expect(git(b.dir, 'status', '--porcelain', '-uall')).toBe('');

      // A edits a note and pushes; B pulls and its agent files follow.
      await writeClaudeNote(a, 'build.md', 'Build with pnpm 9, never npm.\n');
      await add(a);
      expect((await push(a)).status).toBe('pushed');
      const secondPull = await pull(b);
      expect(secondPull.agents.map((r) => [r.agent, r.written])).toEqual([
        ['codex', 1],
        ['cursor', 1],
      ]);
      for (const file of [codexFile, cursorFile]) {
        const text = await readFile(file, 'utf8');
        expect(text).toContain('Build with pnpm 9, never npm.');
        expect(text).not.toContain('Build with pnpm.\n');
      }
      expect(git(b.dir, 'status', '--porcelain', '-uall')).toBe('');

      // B turns Cursor off: its file and exclude lines go; Codex's stay.
      const disabled = await locked(b, 'stak memory agents disable', () =>
        disableAgentMemory(b.home, 'cursor'),
      );
      expect(disabled).toMatchObject({
        removed: 1,
        kept: [],
        failed: [],
        problems: [],
      });
      expect(await exists(cursorFile)).toBe(false);
      const after = await readFile(excludeFile, 'utf8');
      expect(after).not.toContain('stak-memory.mdc');
      expect(after).toContain('/AGENTS.override.md');
      expect(after).toContain('/CLAUDE.local.md');
      expect(await exists(codexFile)).toBe(true);
      expect(git(b.dir, 'status', '--porcelain', '-uall')).toBe('');

      // Later refreshes never bring Cursor back.
      await pull(b);
      expect(await exists(cursorFile)).toBe(false);
    }, 60_000);
  },
);

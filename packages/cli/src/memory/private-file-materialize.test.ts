/**
 * Materialize keeps Claude's private `CLAUDE.local.md` out of Git, with the
 * same fail-closed rules as the Codex/Cursor files (spec 2026-10-28 §5). Write
 * time only: the sync decisions are unchanged.
 */
import { execFileSync } from 'node:child_process';
import {
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
  CANONICAL_MAIN_SCHEMA_VERSION,
  hashBytes,
  planProjectSync,
  readLocalRegistry,
  resolveOrMintProject,
  setBinding,
  STAK_EXCLUDE_BEGIN,
  writeCanonicalMain,
  writeLocalRegistry,
  writeMemoryObject,
} from '@stack/memory';

import { materializeCanonicalProjects } from './canonical-ops.js';

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
let repo: string;
let projectId: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'stak-private-')));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  repo = path.join(root, 'repo');
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

/** A Git checkout bound to a project whose STAK Memory has private
 * instructions (and so materializes `CLAUDE.local.md`). */
const setUp = async (files: Record<string, string> = {}) => {
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Stak Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'README.md'), 'readme\n');
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(repo, name), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');

  let registry = await readLocalRegistry(stackHome);
  const minted = resolveOrMintProject(registry, {
    kind: 'local',
    vendorKey: 'v-repo',
  });
  registry = setBinding(minted.registry, {
    projectId: minted.projectId,
    dir: repo,
    boundAt: '2026-10-28T00:00:00.000Z',
    provenance: 'user-map',
  });
  await writeLocalRegistry(stackHome, registry);
  projectId = minted.projectId;
  await setPrivateInstructions('Answer tersely.\n');
};

const setPrivateInstructions = async (text: string | null) => {
  const bytes = Buffer.from(text ?? 'gone', 'utf8');
  const contentHash = hashBytes(bytes);
  if (text !== null) await writeMemoryObject({ stackHome, contentHash, bytes });
  await writeCanonicalMain(stackHome, {
    schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
    projects: [
      {
        projectId,
        documents: [
          text === null
            ? {
                path: 'instructions/private.md',
                state: 'deleted',
                lastContentHash: contentHash,
                deletedAt: '2026-10-28T00:00:00.000Z',
              }
            : {
                path: 'instructions/private.md',
                state: 'present',
                contentHash,
                importedFrom: 'claude',
                importedAt: '2026-10-28T00:00:00.000Z',
              },
        ],
      },
    ],
  });
};

const materialize = () =>
  materializeCanonicalProjects(stackHome, { claudeHome });
const localFile = () => path.join(repo, 'CLAUDE.local.md');
const excludeText = async () => {
  try {
    return await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  } catch {
    return '';
  }
};
const status = () => git(repo, 'status', '--porcelain', '-uall');

describe.skipIf(!hasGit)('materialize writes CLAUDE.local.md privately', () => {
  it('not ignored: excluded first, then written; git status stays clean', async () => {
    await setUp();
    const outcome = await materialize();
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.written).toBe(1);
    expect(await readFile(localFile(), 'utf8')).toBe('Answer tersely.\n');
    const exclude = await excludeText();
    expect(exclude).toContain('/CLAUDE.local.md\n');
    expect(exclude).toContain('/.CLAUDE.local.md.*.tmp\n');
    expect(status()).toBe('');
  });

  it('already ignored by the repository: written, no extra exclude line', async () => {
    await setUp({
      '.gitignore': 'CLAUDE.local.md\n.CLAUDE.local.md.*.tmp\n',
    });
    const outcome = await materialize();
    expect(outcome.written).toBe(1);
    expect(await exists(localFile())).toBe(true);
    expect(await excludeText()).not.toContain(STAK_EXCLUDE_BEGIN);
    expect(status()).toBe('');
  });

  it('tracked: the user commits it on purpose, so it is written as before with no exclude', async () => {
    await setUp({ 'CLAUDE.local.md': 'Answer tersely.\n' });
    // The working copy is gone (still tracked): materialize writes it back.
    await rm(localFile());
    expect(status()).toBe('D CLAUDE.local.md');
    const outcome = await materialize();
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.written).toBe(1);
    expect(await readFile(localFile(), 'utf8')).toBe('Answer tersely.\n');
    expect(await excludeText()).not.toContain(STAK_EXCLUDE_BEGIN);
    expect(status()).toBe('');
  });

  it('re-included by a .gitignore "!" rule: not written, a note, and the write stays pending', async () => {
    await setUp({ '.gitignore': '!CLAUDE.local.md\n' });
    const outcome = await materialize();
    expect(outcome.written).toBe(0);
    expect(await exists(localFile())).toBe(false);
    expect(outcome.conflicts).toEqual([
      {
        projectId,
        path: '',
        reason: expect.stringContaining(
          'CLAUDE.local.md was not written: this repository\'s .gitignore re-includes it (a "!" rule)',
        ),
      },
    ]);
    expect(await excludeText()).not.toContain('CLAUDE.local.md');
    expect(status()).toBe('');
    // Not recorded as synced: the next run still plans to write it.
    const plan = await planProjectSync({ projectId, dir: repo }, stackHome, {
      claudeHome,
      projects: [{ dir: repo }],
      resolveProjectId: () => projectId,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: 'materialize-write',
        path: 'instructions/private.md',
      }),
    );
  });

  it('deleting the private instructions also releases the exclude lines', async () => {
    await setUp();
    await materialize();
    expect(await excludeText()).toContain('/CLAUDE.local.md\n');

    await setPrivateInstructions(null);
    const outcome = await materialize();
    expect(outcome.deleted).toBe(1);
    expect(await exists(localFile())).toBe(false);
    expect(await excludeText()).not.toContain('CLAUDE.local.md');
  });
});

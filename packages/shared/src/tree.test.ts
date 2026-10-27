import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  UnsafeTreePathError,
  assertSafeTreeLayout,
  copySkillTree,
  copySkillTreeEntries,
  hashSkillDirectory,
  treePathKey,
  validateTreePath,
} from './tree.js';
import type { SkillTreeEntry } from './tree.js';

const temporaryDirectories: string[] = [];
const temp = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stack-tree-'));
  temporaryDirectories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('canonical Skill tree', () => {
  it('retains the Phase 1 deterministic hash behavior', async () => {
    const first = await temp();
    const second = await temp();
    for (const root of [first, second]) {
      await mkdir(path.join(root, 'scripts'));
      await writeFile(path.join(root, 'SKILL.md'), 'skill');
      await writeFile(path.join(root, 'scripts', 'run.js'), 'run');
      await writeFile(path.join(root, '.DS_Store'), 'noise');
    }
    expect((await hashSkillDirectory(first)).hash).toBe(
      (await hashSkillDirectory(second)).hash,
    );
  });

  it('copies meaningful files and nested directories but not noise', async () => {
    const source = await temp();
    const target = path.join(await temp(), 'copy');
    await mkdir(path.join(source, 'assets', 'nested'), { recursive: true });
    await mkdir(path.join(source, '.git'));
    await writeFile(path.join(source, 'SKILL.md'), 'skill');
    await writeFile(
      path.join(source, 'assets', 'nested', 'image.txt'),
      'asset',
    );
    await writeFile(path.join(source, '.git', 'config'), 'noise');
    await writeFile(path.join(source, 'Thumbs.db'), 'noise');

    await copySkillTree(source, target);

    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('skill');
    expect(
      await readFile(
        path.join(target, 'assets', 'nested', 'image.txt'),
        'utf8',
      ),
    ).toBe('asset');
    await expect(lstat(path.join(target, '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await hashSkillDirectory(target)).hash).toBe(
      (await hashSkillDirectory(source)).hash,
    );
  });

  it('preserves nested symlink metadata without following it', async (context) => {
    const source = await temp();
    const target = path.join(await temp(), 'copy');
    await writeFile(path.join(source, 'SKILL.md'), 'skill');
    try {
      await symlink('SKILL.md', path.join(source, 'link.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }

    await copySkillTree(source, target);

    expect((await lstat(path.join(target, 'link.md'))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readlink(path.join(target, 'link.md'))).toBe('SKILL.md');
  });

  it.each([
    '../escape',
    'nested/../../escape',
    '/absolute',
    'C:\\escape',
    'C:',
    'C:foo',
    'C:/x',
    'a:b',
    'dir/file:stream',
  ])('rejects unsafe relative path %s', (unsafe) => {
    expect(() => validateTreePath(unsafe)).toThrow(UnsafeTreePathError);
  });
});

describe('copySkillTreeEntries containment', () => {
  const made: string[] = [];
  afterEach(async () =>
    Promise.all(
      made.splice(0).map((r) => rm(r, { recursive: true, force: true })),
    ),
  );
  const tempRoot = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stack-tree-copy-'));
    made.push(root);
    return root;
  };

  it('refuses a symlink chain instead of writing outside the target (regression)', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'a', 'b', 'c', 'target');
    await expect(
      copySkillTreeEntries(
        [
          { relativePath: 'x', type: 'symlink', target: '.' },
          { relativePath: 'x/x/x/y', type: 'symlink', target: '../../..' },
          {
            relativePath: 'x/x/x/y/pwn',
            type: 'file',
            content: Buffer.from('owned'),
          },
        ],
        target,
      ),
    ).rejects.toBeInstanceOf(UnsafeTreePathError);
    await expect(readFile(path.join(root, 'a', 'pwn'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never writes over a path that already exists in the target', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'SKILL.md'), 'original');
    await expect(
      copySkillTreeEntries(
        [{ relativePath: 'SKILL.md', type: 'file', content: Buffer.from('x') }],
        target,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(
      'original',
    );
  });

  it('refuses to write through a pre-existing link in the target', async (context) => {
    const root = await tempRoot();
    const outside = path.join(root, 'outside');
    const target = path.join(root, 'target');
    await mkdir(outside, { recursive: true });
    await mkdir(target, { recursive: true });
    try {
      // A junction needs no symlink privilege on Windows; elsewhere the type is ignored.
      await symlink(outside, path.join(target, 'docs'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    await expect(
      copySkillTreeEntries(
        [
          {
            relativePath: 'docs/guide.md',
            type: 'file',
            content: Buffer.from('x'),
          },
        ],
        target,
      ),
    ).rejects.toBeInstanceOf(UnsafeTreePathError);
    await expect(
      readFile(path.join(outside, 'guide.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a file/directory clash with a clear error, not a raw EEXIST', async () => {
    const target = path.join(await tempRoot(), 'target');
    await expect(
      copySkillTreeEntries(
        [
          { relativePath: 'a', type: 'file', content: Buffer.from('x') },
          { relativePath: 'a/b', type: 'file', content: Buffer.from('y') },
        ],
        target,
      ),
    ).rejects.toThrow(/both a file and a directory/);
  });
});

describe('assertSafeTreeLayout', () => {
  const file = (relativePath: string): SkillTreeEntry => ({
    relativePath,
    type: 'file',
    content: Buffer.from('x'),
  });

  it.each([
    ['notes', 'Notes'],
    ['ſkill.md', 'skill.md'], // long s folds to s on APFS
    ['ςigma.md', 'σigma.md'], // final sigma folds to sigma
    ['café.md', 'café.md'], // NFC vs NFD
  ])('rejects %s and %s as one name, and says why', (left, right) => {
    expect(() =>
      assertSafeTreeLayout([file(left), file(right), file('SKILL.md')]),
    ).toThrow(/letter case or Unicode form.*macOS or Windows/);
  });

  it('folds long s and final sigma the way APFS does', () => {
    expect(treePathKey('d/ſ')).toBe(treePathKey('d/S'));
    expect(treePathKey('ς')).toBe(treePathKey('Σ'));
    expect(treePathKey('ς')).toBe(treePathKey('σ'));
  });

  it('rejects a path that is both a file and a directory', () => {
    expect(() =>
      assertSafeTreeLayout([file('a'), file('a/b'), file('SKILL.md')]),
    ).toThrow(/both a file and a directory/);
    expect(() =>
      assertSafeTreeLayout([file('a/b'), file('A'), file('SKILL.md')]),
    ).toThrow(UnsafeTreePathError);
  });

  it('accepts an ordinary tree', () => {
    expect(() =>
      assertSafeTreeLayout([file('SKILL.md'), file('a/b'), file('a/c/d')]),
    ).not.toThrow();
  });
});

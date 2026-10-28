import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enumerateSkillTree,
  hashSkillTreeEntries,
  recordedSymlinkTarget,
  type SkillTreeEntry,
} from './tree.js';

// Stand in for a symlink that Windows created from `../SKILL.md`: Node's fs.symlink
// rewrites the separator there, so lstat says "symlink" and readlink returns
// `..\SKILL.md`. Faked here so this runs on every OS without symlink privilege.
const fakeLinks = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    lstat: (async (target: string) => {
      const stats = await actual.lstat(target);
      if (!fakeLinks.has(target)) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false,
      });
    }) as typeof actual.lstat,
    readlink: (async (target: string) =>
      fakeLinks.get(target) ??
      actual.readlink(target)) as typeof actual.readlink,
  };
});

const realPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

const roots: string[] = [];
afterEach(async () => {
  setPlatform(realPlatform);
  fakeLinks.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const treeWithBackslashLink = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-link-target-'));
  roots.push(root);
  await writeFile(path.join(root, 'SKILL.md'), 'skill');
  const link = path.join(root, 'docs-up');
  await writeFile(link, '');
  fakeLinks.set(link, '..\\SKILL.md');
  return root;
};

const portable: SkillTreeEntry[] = [
  { relativePath: 'SKILL.md', type: 'file', content: Buffer.from('skill') },
  { relativePath: 'docs-up', type: 'symlink', target: '../SKILL.md' },
];

describe('symlink targets are recorded with `/` (platform-independent hash)', () => {
  it('on win32, records readlink `..\\SKILL.md` as `../SKILL.md` and hashes it like POSIX does', async () => {
    const root = await treeWithBackslashLink();
    setPlatform('win32');
    const entries = await enumerateSkillTree(root);
    expect(entries.find((entry) => entry.relativePath === 'docs-up')).toEqual({
      relativePath: 'docs-up',
      type: 'symlink',
      target: '../SKILL.md',
    });
    expect(hashSkillTreeEntries(entries)).toBe(hashSkillTreeEntries(portable));
  });

  it('on POSIX, keeps a backslash: it is an ordinary filename character there', async () => {
    const root = await treeWithBackslashLink();
    setPlatform('linux');
    const entries = await enumerateSkillTree(root);
    expect(
      entries.find((entry) => entry.relativePath === 'docs-up'),
    ).toMatchObject({ target: '..\\SKILL.md' });
    expect(hashSkillTreeEntries(entries)).not.toBe(
      hashSkillTreeEntries(portable),
    );
  });

  it('recordedSymlinkTarget only rewrites separators on win32', () => {
    expect(recordedSymlinkTarget('a\\b\\..\\c', 'win32')).toBe('a/b/../c');
    expect(recordedSymlinkTarget('a/b', 'win32')).toBe('a/b');
    expect(recordedSymlinkTarget('a\\b', 'darwin')).toBe('a\\b');
    expect(recordedSymlinkTarget('a\\b', 'linux')).toBe('a\\b');
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  enumerateSkillTree,
  hashSkillDirectory,
  hashSkillTreeEntries,
} from '@stack/shared';
import type { SkillTreeEntry } from '@stack/shared';

import {
  ArchiveIntegrityError,
  ArchivePathError,
  extractSnapshotArchiveToStore,
  ingestSkill,
  packSkillTreeEntries,
  packStoreObject,
  unpackSkillTreeEntries,
  verifyStoredSkill,
} from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-archive-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const makeSkill = async (dir: string) => {
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: demo\ndescription: demo\n---\nbody\n',
  );
  await writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n');
  return (await hashSkillDirectory(dir)).hash;
};

describe('snapshot archive', () => {
  it('round-trips canonical Skill tree entries deterministically', async () => {
    const root = await temp();
    const source = path.join(root, 'foo');
    await makeSkill(source);
    const entries = await enumerateSkillTree(source);
    const first = packSkillTreeEntries(entries);
    const second = packSkillTreeEntries(entries);
    expect(first.archiveHash).toBe(second.archiveHash);
    const unpacked = unpackSkillTreeEntries(first.bytes);
    expect(hashSkillTreeEntries(unpacked)).toBe(hashSkillTreeEntries(entries));
  });

  it('rejects packing an unsafe entry path', () => {
    const entries: SkillTreeEntry[] = [
      { relativePath: '../escape', type: 'file', content: Buffer.from('x') },
    ];
    expect(() => packSkillTreeEntries(entries)).toThrow();
  });

  it('rejects extracting a symlink that escapes the tree', () => {
    const archive = packSkillTreeEntries([
      { relativePath: 'link', type: 'symlink', target: '/etc/passwd' },
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      ArchivePathError,
    );
  });

  it('packs a Store object and extracts it into another Store', async () => {
    const sourceRoot = await temp();
    const source = path.join(sourceRoot, 'foo');
    const contentHash = await makeSkill(source);
    const storeA = path.join(sourceRoot, 'stackA');
    await ingestSkill({
      stackHome: storeA,
      sourcePath: source,
      expectedContentHash: contentHash,
    });
    const archive = await packStoreObject({ stackHome: storeA, contentHash });

    const storeB = path.join(sourceRoot, 'stackB');
    const result = await extractSnapshotArchiveToStore({
      stackHome: storeB,
      contentHash,
      archiveHash: archive.archiveHash,
      bytes: archive.bytes,
    });
    expect(result.contentHash).toBe(contentHash);
    expect(
      (await verifyStoredSkill({ stackHome: storeB, contentHash })).state,
    ).toBe('available');
  });

  it('rejects a downloaded archive whose transport checksum is wrong', async () => {
    const sourceRoot = await temp();
    const source = path.join(sourceRoot, 'foo');
    const contentHash = await makeSkill(source);
    const storeA = path.join(sourceRoot, 'stackA');
    await ingestSkill({
      stackHome: storeA,
      sourcePath: source,
      expectedContentHash: contentHash,
    });
    const archive = await packStoreObject({ stackHome: storeA, contentHash });
    await expect(
      extractSnapshotArchiveToStore({
        stackHome: path.join(sourceRoot, 'stackB'),
        contentHash,
        archiveHash: `sha256:${'0'.repeat(64)}`,
        bytes: archive.bytes,
      }),
    ).rejects.toBeInstanceOf(ArchiveIntegrityError);
  });

  it('rejects archive content that does not hash to the expected Skill hash', async () => {
    const sourceRoot = await temp();
    const source = path.join(sourceRoot, 'foo');
    const contentHash = await makeSkill(source);
    // Build a valid archive of DIFFERENT content, then claim the original hash.
    // The transport checksum matches, so only the canonical Skill-tree hash
    // check can catch the substitution.
    const entries = await enumerateSkillTree(source);
    const tampered = entries.map((entry) =>
      entry.type === 'file' && entry.relativePath === 'SKILL.md'
        ? {
            ...entry,
            content: Buffer.from(
              '---\nname: demo\ndescription: demo\n---\nTAMPERED\n',
            ),
          }
        : entry,
    );
    const archive = packSkillTreeEntries(tampered);
    expect(hashSkillTreeEntries(tampered)).not.toBe(contentHash);
    await expect(
      extractSnapshotArchiveToStore({
        stackHome: path.join(sourceRoot, 'stackB'),
        contentHash,
        archiveHash: archive.archiveHash,
        bytes: archive.bytes,
      }),
    ).rejects.toBeInstanceOf(ArchiveIntegrityError);
  });

  it('preserves symlinks through pack and extract', async () => {
    const sourceRoot = await temp();
    const source = path.join(sourceRoot, 'foo');
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: demo\ndescription: demo\n---\nbody\n',
    );
    let symlinksSupported = true;
    try {
      await symlink('SKILL.md', path.join(source, 'link.md'));
    } catch {
      symlinksSupported = false;
    }
    if (!symlinksSupported) return;
    const contentHash = (await hashSkillDirectory(source)).hash;
    const storeA = path.join(sourceRoot, 'stackA');
    await ingestSkill({
      stackHome: storeA,
      sourcePath: source,
      expectedContentHash: contentHash,
    });
    const archive = await packStoreObject({ stackHome: storeA, contentHash });
    const result = await extractSnapshotArchiveToStore({
      stackHome: path.join(sourceRoot, 'stackB'),
      contentHash,
      archiveHash: archive.archiveHash,
      bytes: archive.bytes,
    });
    expect(result.contentHash).toBe(contentHash);
  });
});

describe('snapshot archive: crafted symlink layouts', () => {
  const file = (relativePath: string, text = 'x'): SkillTreeEntry => ({
    relativePath,
    type: 'file',
    content: Buffer.from(text),
  });
  const link = (relativePath: string, target: string): SkillTreeEntry => ({
    relativePath,
    type: 'symlink',
    target,
  });

  /** Packs entries exactly as an attacker would, with a self-consistent content hash. */
  const extract = async (stackHome: string, entries: SkillTreeEntry[]) => {
    const archive = packSkillTreeEntries(entries);
    return extractSnapshotArchiveToStore({
      stackHome,
      contentHash: hashSkillTreeEntries(entries),
      archiveHash: archive.archiveHash,
      bytes: archive.bytes,
    });
  };

  it('rejects a symlink chain that would write a file outside the store (regression)', async () => {
    // `x -> .` then `x/x/x/y -> ../../..` each look in-tree on their own, but writing
    // `x/x/x/y/pwn` follows both links and lands three levels above the staging root.
    const root = await temp();
    const stackHome = path.join(root, 'a', 'b', 'c', 'stack');
    await mkdir(stackHome, { recursive: true });
    await expect(
      extract(stackHome, [
        link('x', '.'),
        link('x/x/x/y', '../../..'),
        file('x/x/x/y/pwn', 'owned'),
      ]),
    ).rejects.toBeInstanceOf(ArchivePathError);
    const escaped = await enumerateSkillTree(root).catch(() => []);
    expect(escaped.map((entry) => entry.relativePath)).not.toContainEqual(
      expect.stringMatching(/(^|\/)pwn$/),
    );
  });

  it('rejects any entry nested beneath a symlink entry', () => {
    const archive = packSkillTreeEntries([
      link('docs', 'real'),
      file('docs/SKILL.md'),
      file('real/keep.md'),
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      ArchivePathError,
    );
  });

  it('rejects a symlink target that resolves through another symlink', () => {
    // Lexically `d/s/../victim` is `d/victim`, but the OS follows `d/s` (-> the tree
    // root) before applying `..`, which leaves the tree.
    const archive = packSkillTreeEntries([
      link('d/s', '..'),
      link('e', 'd/s/../victim'),
      file('SKILL.md'),
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      ArchivePathError,
    );
  });

  it('rejects two entries naming the same path on case-insensitive filesystems', () => {
    const archive = packSkillTreeEntries([
      link('Notes', 'SKILL.md'),
      file('notes', 'overwrite through the link'),
      file('SKILL.md'),
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      ArchivePathError,
    );
  });

  it('still accepts ordinary in-tree symlinks, including a link to a link', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const entries = [
      file('SKILL.md', '---\nname: demo\ndescription: demo\n---\nbody\n'),
      file('docs/guide.md', 'guide'),
      link('guide', 'docs/guide.md'),
      link('alias', 'guide'),
      link('docs/up', '../SKILL.md'),
    ];
    const result = await extract(stackHome, entries);
    expect(result.contentHash).toBe(hashSkillTreeEntries(entries));
  });
});

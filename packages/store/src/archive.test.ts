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
  assertExtractedSymlinksContained,
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

  it('keeps a literal backslash in an archive symlink target verbatim and still checks it as a separator', () => {
    // Untrusted archive input is never rewritten (only targets read from local disk are
    // normalised to `/`): the parsed target, and so the hash, keep the archive's spelling.
    const inTree = packSkillTreeEntries([
      file('SKILL.md'),
      file('docs/guide.md'),
      link('docs/up', '..\\SKILL.md'),
    ]);
    expect(
      unpackSkillTreeEntries(inTree.bytes).find(
        (entry) => entry.relativePath === 'docs/up',
      ),
    ).toMatchObject({ target: '..\\SKILL.md' });
    // The containment walk treats `\` as a separator, as Windows would.
    for (const target of [
      '..\\..\\outside',
      '\\absolute',
      'C:\\Windows',
      'docs\\..\\..\\x',
    ])
      expect(() =>
        unpackSkillTreeEntries(
          packSkillTreeEntries([file('SKILL.md'), link('docs/up', target)])
            .bytes,
        ),
      ).toThrow(ArchivePathError);
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

  const ordinaryLinks = () => [
    file('SKILL.md', '---\nname: demo\ndescription: demo\n---\nbody\n'),
    file('docs/guide.md', 'guide'),
    link('guide', 'docs/guide.md'),
    link('alias', 'guide'),
    link('docs/up', '../SKILL.md'),
    link('docs/self', '../docs/guide.md'),
  ];

  it('parses ordinary in-tree symlinks, including a link to a link', () => {
    const archive = packSkillTreeEntries(ordinaryLinks());
    expect(() => unpackSkillTreeEntries(archive.bytes)).not.toThrow();
  });

  it('still accepts ordinary in-tree symlinks, including a link to a link', async (context) => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const entries = ordinaryLinks();
    let result: { contentHash: string };
    try {
      result = await extract(stackHome, entries);
    } catch (error) {
      const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
      if (cause?.code === 'EPERM') context.skip();
      throw error;
    }
    expect(result.contentHash).toBe(hashSkillTreeEntries(entries));
  });

  const rejects = (entries: SkillTreeEntry[]) => {
    const archive = packSkillTreeEntries(entries);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      ArchivePathError,
    );
  };

  it.each([
    ['long s (U+017F), folded to s by APFS', 's', '\u017F'],
    ['final sigma, folded to sigma by APFS', '\u03C3', '\u03C2'],
    ['plain case difference', 's', 'S'],
  ])(
    'rejects a walk through an unknown segment that a case-folding filesystem maps onto a symlink: %s',
    (_label, linkName, walkedName) => {
      // On macOS `d/<walkedName>` is `d/<linkName>` (-> `..`), so `d/L` would land above
      // the tree. The walk must not trust a name the archive never created as a directory.
      rejects([
        link(`d/${linkName}`, '..'),
        link('d/L', `${walkedName}/../..`),
        file('SKILL.md'),
      ]);
    },
  );

  it.each(['nope/../x', 'SKILL.md/../x', 'docs/nope/../guide.md'])(
    'rejects a target walking through %s, which is not a directory in the archive',
    (target) => {
      rejects([
        file('SKILL.md'),
        file('docs/guide.md'),
        file('x'),
        link('l', target),
      ]);
    },
  );

  it.each(['C:', 'C:foo', 'C:/x', 'a:b', 'docs/file:stream'])(
    'rejects the drive-relative or stream symlink target %s',
    (target) => {
      rejects([file('SKILL.md'), link('l', target)]);
    },
  );

  it.each(['a:b', 'C:', 'C:foo', 'docs/file:stream'])(
    'rejects the entry path %s',
    (unsafe) => {
      // The packer refuses these, so craft the header by hand: pack a same-length safe
      // name, then patch the bytes (the reader does not verify the header checksum).
      const safe = unsafe.replaceAll(':', '_');
      const archive = packSkillTreeEntries([file('SKILL.md'), file(safe)]);
      const bytes = new Uint8Array(archive.bytes);
      const encoded = new TextEncoder().encode(unsafe);
      for (let offset = 0; offset < bytes.length; offset += 512) {
        const name = new TextDecoder().decode(
          bytes.subarray(offset, offset + 100),
        );
        if (name.startsWith(`${safe}\0`)) bytes.set(encoded, offset);
      }
      expect(() => unpackSkillTreeEntries(bytes)).toThrow(ArchivePathError);
    },
  );

  it('rejects a path that is both a file and a directory, with a clear reason', () => {
    const archive = packSkillTreeEntries([
      file('a'),
      file('a/b'),
      file('SKILL.md'),
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      /both a file and a directory/,
    );
  });

  it('explains why case-duplicate names are refused', () => {
    const archive = packSkillTreeEntries([
      file('SKILL.md'),
      file('notes'),
      file('Notes'),
    ]);
    expect(() => unpackSkillTreeEntries(archive.bytes)).toThrow(
      /letter case or Unicode form.*macOS or Windows/,
    );
  });
});

describe('assertExtractedSymlinksContained', () => {
  const tryLink = async (
    context: { skip: () => void },
    target: string,
    at: string,
  ) => {
    try {
      await symlink(target, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
  };

  it('rejects a link the filesystem resolves outside the tree', async (context) => {
    const root = await temp();
    const tree = path.join(root, 'tree');
    await mkdir(path.join(root, 'outside'), { recursive: true });
    await mkdir(tree, { recursive: true });
    await tryLink(context, '../outside', path.join(tree, 'l'));
    await expect(
      assertExtractedSymlinksContained(tree, [
        { relativePath: 'l', type: 'symlink', target: '../outside' },
      ]),
    ).rejects.toBeInstanceOf(ArchivePathError);
  });

  it('allows a dangling link only when it stays inside the tree', async (context) => {
    const root = await temp();
    const tree = path.join(root, 'tree');
    await mkdir(tree, { recursive: true });
    await tryLink(context, 'missing.md', path.join(tree, 'inside'));
    await tryLink(context, '../missing.md', path.join(tree, 'outside'));
    await expect(
      assertExtractedSymlinksContained(tree, [
        { relativePath: 'inside', type: 'symlink', target: 'missing.md' },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      assertExtractedSymlinksContained(tree, [
        { relativePath: 'outside', type: 'symlink', target: '../missing.md' },
      ]),
    ).rejects.toBeInstanceOf(ArchivePathError);
  });
});

import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';

import {
  ContentHashMismatchError,
  MaterializationTargetExistsError,
  StoreObjectCorruptError,
  UnsafeStorePathError,
  contentObjectPaths,
  ingestSkill,
  materializeStoredSkill,
  verifyStoredSkill,
} from './index.js';

const temporaryDirectories: string[] = [];
const temp = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stack-store-'));
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

const makeSkill = async () => {
  const source = await temp();
  await mkdir(path.join(source, 'scripts'));
  await mkdir(path.join(source, 'assets', 'nested'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: one\n---\n');
  await writeFile(path.join(source, 'scripts', 'run.js'), 'run');
  await writeFile(path.join(source, 'assets', 'nested', 'data.txt'), 'asset');
  return source;
};

describe('content-addressed Skill store', () => {
  it('places objects beneath STACK_HOME by canonical hash', async () => {
    const stackHome = await temp();
    const contentHash = `sha256:${'a'.repeat(64)}`;
    expect(contentObjectPaths(stackHome, contentHash).objectDirectory).toBe(
      path.join(stackHome, 'store', 'sha256', 'aa', 'a'.repeat(64)),
    );
  });

  it('ingests one immutable object with complete meaningful content', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;

    const result = await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      contentHash: expectedContentHash,
      reused: false,
    });
    expect(
      await readFile(path.join(result.contentPath, 'SKILL.md'), 'utf8'),
    ).toContain('name: one');
    expect(
      await readFile(
        path.join(result.contentPath, 'scripts', 'run.js'),
        'utf8',
      ),
    ).toBe('run');
    expect(
      await readFile(
        path.join(result.contentPath, 'assets', 'nested', 'data.txt'),
        'utf8',
      ),
    ).toBe('asset');
    expect(
      await verifyStoredSkill({ stackHome, contentHash: expectedContentHash }),
    ).toMatchObject({ state: 'available' });
  });

  it('reuses a healthy existing object for duplicate content', async () => {
    const source = await makeSkill();
    const duplicate = await temp();
    const { cp } = await import('node:fs/promises');
    await cp(source, duplicate, { recursive: true });
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    const first = await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash,
    });
    const second = await ingestSkill({
      stackHome,
      sourcePath: duplicate,
      expectedContentHash,
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.objectPath).toBe(first.objectPath);
  });

  it('does not mutate the source and remains independent after source mutation', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    const sourceBefore = await readFile(path.join(source, 'SKILL.md'), 'utf8');
    await ingestSkill({ stackHome, sourcePath: source, expectedContentHash });
    expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
      sourceBefore,
    );
    await writeFile(path.join(source, 'SKILL.md'), 'changed');
    expect(
      await verifyStoredSkill({ stackHome, contentHash: expectedContentHash }),
    ).toMatchObject({ state: 'available' });
  });

  it('rejects an expected hash mismatch and cleans staging', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const wrongHash = `sha256:${'b'.repeat(64)}`;
    await expect(
      ingestSkill({
        stackHome,
        sourcePath: source,
        expectedContentHash: wrongHash,
      }),
    ).rejects.toBeInstanceOf(ContentHashMismatchError);
    const bucket = path.join(stackHome, 'store', 'sha256', 'bb');
    expect(await readdir(bucket).catch(() => [])).toEqual([]);
  });

  it('reports missing and malformed store objects without repairing them', async () => {
    const stackHome = await temp();
    const contentHash = `sha256:${'c'.repeat(64)}`;
    expect(await verifyStoredSkill({ stackHome, contentHash })).toMatchObject({
      state: 'missing',
      code: 'object-missing',
    });
    const paths = contentObjectPaths(stackHome, contentHash);
    await mkdir(paths.contentPath, { recursive: true });
    await writeFile(path.join(paths.contentPath, 'SKILL.md'), 'wrong');
    expect(await verifyStoredSkill({ stackHome, contentHash })).toMatchObject({
      state: 'corrupt',
      code: 'metadata-missing',
    });
  });

  it('rejects a corrupt existing object instead of overwriting it', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    const ingested = await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash,
    });
    await writeFile(path.join(ingested.contentPath, 'SKILL.md'), 'corrupt');
    await expect(
      ingestSkill({ stackHome, sourcePath: source, expectedContentHash }),
    ).rejects.toBeInstanceOf(StoreObjectCorruptError);
    expect(
      await readFile(path.join(ingested.contentPath, 'SKILL.md'), 'utf8'),
    ).toBe('corrupt');
  });

  it('materializes exact content atomically and refuses an existing target', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    await ingestSkill({ stackHome, sourcePath: source, expectedContentHash });
    const parent = await temp();
    const targetPath = path.join(parent, 'restored');
    const materialized = await materializeStoredSkill({
      stackHome,
      contentHash: expectedContentHash,
      targetPath,
    });
    expect(materialized.contentHash).toBe(expectedContentHash);
    expect((await hashSkillDirectory(targetPath)).hash).toBe(
      expectedContentHash,
    );
    await expect(
      materializeStoredSkill({
        stackHome,
        contentHash: expectedContentHash,
        targetPath,
      }),
    ).rejects.toBeInstanceOf(MaterializationTargetExistsError);
  });

  it('cleans materialization staging when verification fails', async () => {
    const source = await makeSkill();
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    const ingested = await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash,
    });
    await writeFile(path.join(ingested.contentPath, 'SKILL.md'), 'corrupt');
    const parent = await temp();
    const targetPath = path.join(parent, 'restored');
    await expect(
      materializeStoredSkill({
        stackHome,
        contentHash: expectedContentHash,
        targetPath,
      }),
    ).rejects.toBeInstanceOf(StoreObjectCorruptError);
    expect(await readdir(parent)).toEqual([]);
  });

  it('preserves supported nested symlinks through ingest and materialization', async (context) => {
    const source = await makeSkill();
    try {
      await symlink('SKILL.md', path.join(source, 'skill-link.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    const stackHome = await temp();
    const expectedContentHash = (await hashSkillDirectory(source)).hash;
    await ingestSkill({ stackHome, sourcePath: source, expectedContentHash });
    const targetPath = path.join(await temp(), 'restored');
    await materializeStoredSkill({
      stackHome,
      contentHash: expectedContentHash,
      targetPath,
    });
    expect(
      (await lstat(path.join(targetPath, 'skill-link.md'))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(path.join(targetPath, 'skill-link.md'))).toBe(
      'SKILL.md',
    );
  });

  it.each(['not-a-hash', 'sha256:../escape'])(
    'rejects unsafe store key %s',
    (contentHash) => {
      expect(() => contentObjectPaths('C:/stack', contentHash)).toThrow(
        UnsafeStorePathError,
      );
    },
  );
});

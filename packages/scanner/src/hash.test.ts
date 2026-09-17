import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from './hash.js';

const temporaryDirectories: string[] = [];

const makeSkill = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stack-hash-'));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, 'SKILL.md'), 'skill content');
  return directory;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('hashSkillDirectory', () => {
  it('produces the same hash for identical trees at different paths', async () => {
    const first = await makeSkill();
    const second = await makeSkill();

    expect((await hashSkillDirectory(first)).hash).toBe(
      (await hashSkillDirectory(second)).hash,
    );
  });

  it('changes when meaningful nested content changes', async () => {
    const directory = await makeSkill();
    const before = await hashSkillDirectory(directory);
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'scripts', 'run.js'), 'meaningful');

    expect((await hashSkillDirectory(directory)).hash).not.toBe(before.hash);
  });

  it('ignores filesystem noise', async () => {
    const directory = await makeSkill();
    const before = await hashSkillDirectory(directory);
    await mkdir(path.join(directory, '.git'));
    await writeFile(path.join(directory, '.git', 'config'), 'noise');
    await writeFile(path.join(directory, '.DS_Store'), 'noise');
    await writeFile(path.join(directory, 'Thumbs.db'), 'noise');

    expect((await hashSkillDirectory(directory)).hash).toBe(before.hash);
  });

  it('includes assets in the hash', async () => {
    const directory = await makeSkill();
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'assets', 'data.txt'), 'first');
    const before = await hashSkillDirectory(directory);
    await writeFile(path.join(directory, 'assets', 'data.txt'), 'second');

    expect((await hashSkillDirectory(directory)).hash).not.toBe(before.hash);
  });
});

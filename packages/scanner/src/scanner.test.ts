import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SkillRoot } from '@stack/spec';

import { scanSkills } from './scanner.js';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures/skills');
const temporaryDirectories: string[] = [];

const temp = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stack-scan-'));
  temporaryDirectories.push(directory);
  return directory;
};

const root = (
  directory: string,
  rootKind: SkillRoot['rootKind'] = 'codex',
  scope: SkillRoot['scope'] = 'global',
): SkillRoot => ({
  path: directory,
  rootKind,
  scope,
});

const copyFixture = async (name: string, destination: string) =>
  cp(path.join(fixtures, name), destination, { recursive: true });

const snapshot = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      values.push(
        ...(await snapshot(entryPath)).map((value) => `${entry.name}/${value}`),
      );
    else values.push(`${entry.name}:${await readFile(entryPath, 'utf8')}`);
  }
  return values;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('scanSkills', () => {
  it('treats missing roots as a successful empty scan', async () => {
    const result = await scanSkills({
      roots: [root(path.join(await temp(), 'missing'))],
    });

    expect(result.roots[0]?.status).toBe('missing');
    expect(result.summary).toMatchObject({
      locations: 0,
      uniqueSkillContents: 0,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('scans an empty root', async () => {
    const directory = await temp();
    const result = await scanSkills({ roots: [root(directory)] });

    expect(result.roots[0]).toMatchObject({
      status: 'scanned',
      skillLocations: 0,
    });
  });

  it('discovers and parses one valid Skill', async () => {
    const directory = await temp();
    await copyFixture('valid-basic', path.join(directory, 'valid-basic'));

    const result = await scanSkills({ roots: [root(directory)] });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      metadata: {
        name: 'valid-basic',
        description: 'A minimal valid Skill fixture.',
        category: 'testing',
      },
      valid: true,
    });
  });

  it('discovers Skills beneath organizational directories', async () => {
    const directory = await temp();
    await copyFixture('nested-skill', path.join(directory, 'nested'));

    const result = await scanSkills({ roots: [root(directory)] });

    expect(result.skills[0]?.locations[0]?.path).toBe(
      path.join(directory, 'nested', 'organization', 'deep'),
    );
  });

  it('merges exact duplicate content while preserving physical locations', async () => {
    const first = await temp();
    const second = await temp();
    await copyFixture('valid-basic', path.join(first, 'valid-basic'));
    await copyFixture('duplicate-copy', path.join(second, 'valid-basic'));

    const result = await scanSkills({
      roots: [root(first, 'cursor'), root(second, 'codex')],
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.locations).toHaveLength(2);
    expect(result.summary.exactDuplicateContents).toBe(1);
  });

  it('keeps same-name different-content Skills separate and reports a collision', async () => {
    const directory = await temp();
    await copyFixture('valid-basic', path.join(directory, 'first'));
    await copyFixture(
      'same-name-different-content',
      path.join(directory, 'second'),
    );

    const result = await scanSkills({ roots: [root(directory)] });
    const contentHashes = result.skills.map((skill) => skill.contentHash);

    expect(result.skills).toHaveLength(2);
    expect(result.nameCollisions).toEqual([
      {
        name: 'valid-basic',
        contentHashes: expect.arrayContaining(contentHashes),
      },
    ]);
  });

  it.each(['invalid-frontmatter', 'missing-name', 'missing-description'])(
    'reports invalid fixture %s and continues',
    async (fixture) => {
      const directory = await temp();
      await copyFixture(fixture, path.join(directory, fixture));
      await copyFixture('valid-basic', path.join(directory, 'valid-basic'));

      const result = await scanSkills({ roots: [root(directory)] });

      expect(result.skills).toHaveLength(2);
      expect(result.summary.invalidSkills).toBe(1);
      expect(
        result.diagnostics.some(
          (diagnostic) => diagnostic.severity === 'error',
        ),
      ).toBe(true);
    },
  );

  it('preserves physical root kind and global/project scope separately', async () => {
    const globalRoot = await temp();
    const projectRoot = await temp();
    await copyFixture('valid-basic', path.join(globalRoot, 'valid-basic'));
    await copyFixture('with-assets', path.join(projectRoot, 'with-assets'));

    const result = await scanSkills({
      roots: [
        root(globalRoot, 'agents'),
        root(projectRoot, 'cursor', 'project'),
      ],
    });

    expect(result.skills.flatMap((skill) => skill.locations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootKind: 'agents', scope: 'global' }),
        expect.objectContaining({ rootKind: 'cursor', scope: 'project' }),
      ]),
    );
  });

  it('does not mutate discovered Skill directories', async () => {
    const directory = await temp();
    await copyFixture('with-script', path.join(directory, 'with-script'));
    const before = await snapshot(directory);

    await scanSkills({ roots: [root(directory)] });

    expect(await snapshot(directory)).toEqual(before);
  });

  it('reports a non-directory root failure and continues', async () => {
    const directory = await temp();
    const invalidRoot = path.join(directory, 'file');
    await writeFile(invalidRoot, 'not a directory');

    const result = await scanSkills({
      roots: [
        root(invalidRoot),
        root(path.join(directory, 'missing'), 'cursor'),
      ],
    });

    expect(result.roots.map((entry) => entry.status)).toEqual([
      'failed',
      'missing',
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'root-scan-failed',
    });
  });

  it('reports direct Skill symlinks without traversing cycles', async (context) => {
    const directory = await temp();
    const target = path.join(directory, 'target');
    const visibleRoot = path.join(directory, 'visible');
    await mkdir(visibleRoot);
    await copyFixture('valid-basic', target);
    try {
      await symlink(target, path.join(visibleRoot, 'linked'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }

    const result = await scanSkills({ roots: [root(visibleRoot)] });
    const location = result.skills[0]?.locations[0];

    expect(location).toMatchObject({
      isSymlink: true,
      path: path.join(visibleRoot, 'linked'),
      realPath: await lstat(target).then(() => target),
    });
  });

  it('does not follow nested symlinks inside Skill content', async (context) => {
    const directory = await temp();
    const skill = path.join(directory, 'valid-basic');
    const external = path.join(directory, 'external.txt');
    await copyFixture('valid-basic', skill);
    await writeFile(external, 'outside content');
    try {
      await symlink(external, path.join(skill, 'external-link'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }

    const result = await scanSkills({ roots: [root(directory)] });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'nested-symlink-not-followed' }),
    );
  });
});

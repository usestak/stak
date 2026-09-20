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

// Write a Skill whose declared name matches its directory (so no name-mismatch
// warning) and whose body is unique (so its content hash is unique).
const writeSkill = async (directory: string, name: string, body = name) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n${body}\n`,
  );
};

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

  it('skips bundled .system Skills only in the legacy Codex root', async () => {
    const directory = await temp();
    await copyFixture(
      'valid-basic',
      path.join(directory, '.system', 'bundled'),
    );
    await copyFixture('with-assets', path.join(directory, 'legacy-user'));

    const result = await scanSkills({ roots: [root(directory, 'codex')] });

    expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
      'with-assets',
    ]);
    expect(result.roots[0]?.skillLocations).toBe(1);
  });

  it('does not apply the Codex .system exclusion to shared roots', async () => {
    const directory = await temp();
    await copyFixture('valid-basic', path.join(directory, '.system', 'user'));

    const result = await scanSkills({ roots: [root(directory, 'agents')] });

    expect(result.skills).toHaveLength(1);
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

  describe('Claude vendor-managed reserved subtrees', () => {
    it('discovers a Claude personal Skill directly under the Claude root', async () => {
      const directory = await temp();
      await writeSkill(path.join(directory, 'my-skill'), 'my-skill');

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'my-skill',
      ]);
    });

    it('excludes account-synced Skills under the reserved synced/ subtree', async () => {
      const directory = await temp();
      await writeSkill(path.join(directory, 'personal'), 'personal');
      await writeSkill(
        path.join(directory, 'synced', 'sync-abc', 'pdf'),
        'pdf',
      );

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'personal',
      ]);
      expect(result.diagnostics).toEqual([]);
    });

    it('excludes multiple synced Skills under one sync id', async () => {
      const directory = await temp();
      const synced = path.join(directory, 'synced', 'sync-xyz');
      for (const name of ['docs', 'docx', 'pdf', 'pptx', 'xlsx'])
        await writeSkill(path.join(synced, name), name);
      await writeSkill(path.join(directory, 'real'), 'real');

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'real',
      ]);
      expect(result.summary.uniqueSkillContents).toBe(1);
    });

    it('excludes Skills under the Claude .trash/ subtree', async () => {
      const directory = await temp();
      await writeSkill(
        path.join(directory, '.trash', 'old-skill'),
        'old-skill',
      );
      await writeSkill(path.join(directory, 'kept'), 'kept');

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'kept',
      ]);
    });

    it('excludes the reserved synced subtree case-insensitively', async () => {
      const directory = await temp();
      await writeSkill(
        path.join(directory, 'Synced', 'sync-1', 'skill'),
        'skill',
      );
      await writeSkill(path.join(directory, 'personal'), 'personal');

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'personal',
      ]);
    });

    it('does not exclude a nested folder named synced inside an ordinary Skill', async () => {
      const directory = await temp();
      // `wrapper` has no SKILL.md, so discovery recurses; the `synced` here is at
      // depth 1 (not immediately under the root) and must NOT be excluded.
      await writeSkill(path.join(directory, 'wrapper', 'synced'), 'synced');

      const result = await scanSkills({ roots: [root(directory, 'claude')] });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'synced',
      ]);
      expect(result.skills[0]?.locations[0]?.path).toBe(
        path.join(directory, 'wrapper', 'synced'),
      );
    });

    it('excludes the synced subtree under a project Claude root', async () => {
      const directory = await temp();
      await writeSkill(path.join(directory, 'proj-skill'), 'proj-skill');
      await writeSkill(
        path.join(directory, 'synced', 'sync-p', 'morning'),
        'morning',
      );

      const result = await scanSkills({
        roots: [root(directory, 'claude', 'project')],
      });

      expect(result.skills.map((skill) => skill.metadata?.name)).toEqual([
        'proj-skill',
      ]);
    });

    it('dedupes a Claude personal Skill against an identical shared .agents copy', async () => {
      const claudeRoot = await temp();
      const agentsRoot = await temp();
      await writeSkill(
        path.join(claudeRoot, 'design'),
        'design',
        'shared body',
      );
      await writeSkill(
        path.join(agentsRoot, 'design'),
        'design',
        'shared body',
      );

      const result = await scanSkills({
        roots: [root(agentsRoot, 'agents'), root(claudeRoot, 'claude')],
      });

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.locations).toHaveLength(2);
      expect(result.summary.exactDuplicateContents).toBe(1);
    });

    it('discovers only the 31 real Skills across a synced + .system fixture', async () => {
      const claudeRoot = await temp();
      const codexRoot = await temp();
      // 31 real, unique-content personal Skills.
      for (let index = 0; index < 31; index += 1)
        await writeSkill(
          path.join(claudeRoot, `real-${index}`),
          `real-${index}`,
        );
      // 8 Claude account-synced Skills (must be excluded).
      const synced = path.join(claudeRoot, 'synced', 'sync-id');
      for (const name of [
        'docs',
        'docx',
        'import-memory',
        'morning',
        'pdf',
        'pptx',
        'skill-creator',
        'xlsx',
      ])
        await writeSkill(path.join(synced, name), name);
      // 1 Codex bundled system Skill (must be excluded).
      await writeSkill(
        path.join(codexRoot, '.system', 'skill-creator'),
        'skill-creator',
      );

      const result = await scanSkills({
        roots: [root(claudeRoot, 'claude'), root(codexRoot, 'codex')],
      });

      expect(result.summary.uniqueSkillContents).toBe(31);
      const claudeScanned = result.roots.find(
        (entry) => entry.rootKind === 'claude',
      );
      const codexScanned = result.roots.find(
        (entry) => entry.rootKind === 'codex',
      );
      expect(claudeScanned?.skillLocations).toBe(31);
      expect(codexScanned?.skillLocations).toBe(0);
    }, 30_000);

    it('does not modify any source files when reserved subtrees are present', async () => {
      const directory = await temp();
      await writeSkill(path.join(directory, 'personal'), 'personal');
      await writeSkill(path.join(directory, 'synced', 'sync-1', 'pdf'), 'pdf');
      await writeSkill(path.join(directory, '.trash', 'gone'), 'gone');
      const before = await snapshot(directory);

      await scanSkills({ roots: [root(directory, 'claude')] });

      expect(await snapshot(directory)).toEqual(before);
    });
  });
});

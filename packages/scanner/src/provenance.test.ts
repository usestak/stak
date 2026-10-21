import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectProvenance } from './provenance.js';

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('detectProvenance', () => {
  it('records local Git evidence without network access', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'stack-git-'));
    directories.push(repository);
    const skill = path.join(repository, 'skills', 'demo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), 'demo');
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repository,
    });
    execFileSync('git', ['config', 'user.name', 'Stack Test'], {
      cwd: repository,
    });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://example.com/skills.git'],
      { cwd: repository },
    );
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

    const source = await detectProvenance(skill);

    expect(source).toMatchObject({
      type: 'git',
      remote: 'https://example.com/skills.git',
      path: 'skills/demo',
      clean: true,
    });
    expect(source.type === 'git' && source.revision).toMatch(/^[0-9a-f]{40}$/);
    // The tracked ref (source locator) is captured as a fully-qualified ref on a branch
    // checkout — distinct from the resolved commit — so source-latest can re-resolve it.
    expect(source.type === 'git' && source.ref).toMatch(/^refs\/heads\/.+/);
  }, 15_000);

  it('omits the tracked ref on a detached HEAD (exact-commit-pinned)', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'stack-git-detach-'));
    directories.push(repository);
    const skill = path.join(repository, 'skills', 'demo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), 'demo');
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repository,
    });
    execFileSync('git', ['config', 'user.name', 'Stack Test'], {
      cwd: repository,
    });
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', '--detach', head], {
      cwd: repository,
    });

    const source = await detectProvenance(skill);
    expect(source.type).toBe('git');
    expect(source.type === 'git' && source.ref).toBeUndefined();
  }, 15_000);

  it.each([
    [
      'modified tracked content',
      async (skill: string) =>
        writeFile(path.join(skill, 'SKILL.md'), 'changed'),
    ],
    [
      'an untracked file',
      async (skill: string) => writeFile(path.join(skill, 'new.txt'), 'new'),
    ],
  ])(
    'marks a Git Skill dirty when it contains %s',
    async (_label, mutate) => {
      const repository = await mkdtemp(path.join(tmpdir(), 'stack-git-dirty-'));
      directories.push(repository);
      const skill = path.join(repository, 'skills', 'demo');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, 'SKILL.md'), 'demo');
      execFileSync('git', ['init', '-q'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: repository,
      });
      execFileSync('git', ['config', 'user.name', 'Stack Test'], {
        cwd: repository,
      });
      execFileSync('git', ['add', '.'], { cwd: repository });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
      await mutate(skill);

      expect(await detectProvenance(skill)).toMatchObject({
        type: 'git',
        clean: false,
      });
    },
    15_000,
  );

  it('reports a non-Git directory as local', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stack-local-'));
    directories.push(directory);

    expect(await detectProvenance(directory)).toEqual({ type: 'local' });
  });

  // The fast path short-circuits the `git` subprocess entirely for a confirmed-local
  // directory by walking ancestors in pure JS, caching per-directory across calls — this
  // proves that sharing one cache across sibling calls never conflates "no .git up to here"
  // for one directory with a DIFFERENT sibling directory that genuinely has its own .git.
  it('correctly distinguishes Git from local siblings sharing a cache, even sharing a non-Git parent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stack-mixed-'));
    directories.push(root);
    const { mkdir } = await import('node:fs/promises');
    const gitSkill = path.join(root, 'skills', 'one');
    const localSkill = path.join(root, 'skills', 'two');
    await mkdir(gitSkill, { recursive: true });
    await mkdir(localSkill, { recursive: true });
    await writeFile(path.join(gitSkill, 'SKILL.md'), 'demo');
    await writeFile(path.join(localSkill, 'SKILL.md'), 'demo');
    execFileSync('git', ['init', '-q'], { cwd: gitSkill });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: gitSkill,
    });
    execFileSync('git', ['config', 'user.name', 'Stack Test'], {
      cwd: gitSkill,
    });
    execFileSync('git', ['add', '.'], { cwd: gitSkill });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: gitSkill });

    const cache = new Map<string, boolean>();
    const [gitSource, localSource] = await Promise.all([
      detectProvenance(gitSkill, cache),
      detectProvenance(localSkill, cache),
    ]);
    expect(gitSource.type).toBe('git');
    expect(localSource).toEqual({ type: 'local' });
  }, 15_000);
});

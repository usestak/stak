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
    });
    expect(source.type === 'git' && source.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a non-Git directory as local', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stack-local-'));
    directories.push(directory);

    expect(await detectProvenance(directory)).toEqual({ type: 'local' });
  });
});

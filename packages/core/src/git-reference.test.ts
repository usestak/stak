import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import { verifyStoredSkill } from '@stack/store';
import { ReferenceRestoreFailedError } from '@stack/cloud-client';

import { restoreReference, type GitExecutor } from './git-reference.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-ref-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const SKILL_PATH = 'skills/demo';
const BODY = '---\nname: demo\ndescription: demo skill\n---\nreference body\n';

const hashOf = async (root: string, body: string) => {
  const dir = path.join(root, 'expected', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return (await hashSkillDirectory(dir)).hash;
};

const fakeGit = (options: {
  content?: string;
  failOn?: string;
}): GitExecutor => {
  const commands: string[][] = [];
  const executor: GitExecutor = async (args, { cwd }) => {
    commands.push(args);
    if (options.failOn && args[0] === options.failOn)
      return { exitCode: 1, stdout: '', stderr: `git ${args[0]} denied` };
    if (args[0] === 'checkout' && options.content !== undefined) {
      const dest = path.join(cwd, ...SKILL_PATH.split('/'));
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), options.content);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return executor;
};

describe('git reference restoration', () => {
  it('restores the exact revision and ingests it into the Store', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const expectedContentHash = await hashOf(root, BODY);
    const result = await restoreReference({
      stackHome,
      reference: {
        remote: 'https://example.com/org/repo.git',
        revision: 'a'.repeat(40),
        path: SKILL_PATH,
        expectedContentHash,
      },
      gitExecutor: fakeGit({ content: BODY }),
    });
    expect(result.contentHash).toBe(expectedContentHash);
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: expectedContentHash }))
        .state,
    ).toBe('available');
  });

  it('fails before ingesting when the restored content hash is wrong', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const expectedContentHash = await hashOf(root, BODY);
    await expect(
      restoreReference({
        stackHome,
        reference: {
          remote: 'https://example.com/org/repo.git',
          revision: 'b'.repeat(40),
          path: SKILL_PATH,
          expectedContentHash,
        },
        gitExecutor: fakeGit({ content: `${BODY}TAMPERED\n` }),
      }),
    ).rejects.toBeInstanceOf(ReferenceRestoreFailedError);
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: expectedContentHash }))
        .state,
    ).toBe('missing');
  });

  it('fails when the revision cannot be fetched', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await expect(
      restoreReference({
        stackHome,
        reference: {
          remote: 'https://example.com/org/repo.git',
          revision: 'c'.repeat(40),
          path: SKILL_PATH,
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        },
        gitExecutor: fakeGit({ failOn: 'fetch' }),
      }),
    ).rejects.toBeInstanceOf(ReferenceRestoreFailedError);
  });

  it('rejects a non-repository-relative reference path', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await expect(
      restoreReference({
        stackHome,
        reference: {
          remote: 'https://example.com/org/repo.git',
          revision: 'd'.repeat(40),
          path: '../escape',
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        },
        gitExecutor: fakeGit({ content: BODY }),
      }),
    ).rejects.toThrow();
  });
});

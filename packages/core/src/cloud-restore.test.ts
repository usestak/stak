import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { CloudEnvironmentBundle } from '@stack/spec';
import { verifyStoredSkill } from '@stack/store';
import { ReferenceRestoreFailedError } from '@stack/cloud-client';

import { computeEnvironmentDigest } from './cloud-bundle.js';
import { applyCloudRestore } from './cloud-restore.js';
import { type GitExecutor } from './git-reference.js';
import { StackStateError, loadMainEnvironment } from './state.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-restore-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const REMOTE = 'https://example.com/org/repo.git';
const REVISION = 'a'.repeat(40);
const SKILL_PATH = 'skills/demo';
const BODY = '---\nname: ref\ndescription: ref skill\n---\nreference body\n';

const referenceBundle = (contentHash: string): CloudEnvironmentBundle => {
  const environment = {
    schemaVersion: 1 as const,
    name: 'main',
    skills: [
      { id: 'skill_ref00001', name: 'ref', requirement: 'required' as const },
    ],
    stacks: [],
    overrides: {},
  };
  const resolved = {
    schemaVersion: 1 as const,
    skills: {
      skill_ref00001: {
        name: 'ref',
        description: 'ref skill',
        contentHash,
        observedSources: [
          {
            type: 'git' as const,
            remote: REMOTE,
            revision: REVISION,
            path: SKILL_PATH,
          },
        ],
        restoration: {
          strategy: 'reference' as const,
          reference: {
            remote: REMOTE,
            revision: REVISION,
            path: SKILL_PATH,
            expectedContentHash: contentHash,
          },
        },
        origins: [{ type: 'direct' as const, entryId: 'skill_ref00001' }],
      },
    },
  };
  return {
    schemaVersion: 1,
    environment,
    resolved,
    importedStackVersions: [],
    contentUploadRequirements: [],
    digest: computeEnvironmentDigest({
      environment,
      resolved,
      importedStackVersions: [],
    }),
  };
};

const fakeGit =
  (options: { content?: string; failOn?: string }): GitExecutor =>
  async (args, { cwd }) => {
    if (options.failOn && args[0] === options.failOn)
      return { exitCode: 1, stdout: '', stderr: 'denied' };
    if (args[0] === 'checkout' && options.content !== undefined) {
      const dest = path.join(cwd, ...SKILL_PATH.split('/'));
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), options.content);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

const neverDownload = {
  downloadSnapshot: async () => {
    throw new Error('reference-only pull must not download snapshots');
  },
};

const hashOf = async (root: string) => {
  const dir = path.join(root, 'expected', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), BODY);
  return (await hashSkillDirectory(dir)).hash;
};

describe('cloud restore with references', () => {
  it('reacquires a Git reference and commits main', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const contentHash = await hashOf(root);
    const result = await applyCloudRestore({
      stackHome,
      bundle: referenceBundle(contentHash),
      client: neverDownload,
      gitExecutor: fakeGit({ content: BODY }),
    });
    expect(result.referencesRestored).toBe(1);
    expect(result.snapshotsDownloaded).toBe(0);
    const state = await loadMainEnvironment({ stackHome });
    expect(state.lock.skills.skill_ref00001?.restoration.strategy).toBe(
      'reference',
    );
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'available',
    );
  });

  it('does not commit main when a reference cannot be reacquired', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const contentHash = await hashOf(root);
    await expect(
      applyCloudRestore({
        stackHome,
        bundle: referenceBundle(contentHash),
        client: neverDownload,
        gitExecutor: fakeGit({ failOn: 'fetch' }),
      }),
    ).rejects.toBeInstanceOf(ReferenceRestoreFailedError);
    await expect(loadMainEnvironment({ stackHome })).rejects.toBeInstanceOf(
      StackStateError,
    );
  });
});

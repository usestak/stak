import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMainEnvironment } from '@stack/core';

import { bootstrapEmptyMainIfSkillFree } from './program.js';

const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

/** Point `os.homedir()` (and thus `resolveScanRoots`' default) at an isolated, empty
 *  fake home for this test — the real machine's actual Skills must never leak in. */
const useFakeHome = async (): Promise<string> => {
  const fakeHome = await tempDir('fake-home-');
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  return fakeHome;
};

const seedValidSkill = async (fakeHome: string) => {
  const dir = path.join(fakeHome, '.claude', 'skills', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo skill\n---\nBody.\n',
  );
};

describe('bootstrapEmptyMainIfSkillFree (fresh-machine `use` onboarding)', () => {
  it('bootstraps an empty main when main is missing and zero Skills are discovered', async () => {
    const stackHome = await tempDir('stack-home-');
    await useFakeHome();

    const result = await bootstrapEmptyMainIfSkillFree({
      stackHome,
      dryRun: false,
    });

    expect(result).toBe('bootstrapped');
    const state = await loadMainEnvironment({ stackHome });
    expect(state.manifest.stacks).toEqual([]);
  });

  it('--dry-run (dryRun: true) previews the bootstrap WITHOUT writing anything', async () => {
    const stackHome = await tempDir('stack-home-');
    await useFakeHome();

    const result = await bootstrapEmptyMainIfSkillFree({
      stackHome,
      dryRun: true,
    });

    expect(result).toBe('preview');
    // No persistent mutation: main still does not exist.
    await expect(loadMainEnvironment({ stackHome })).rejects.toMatchObject({
      code: 'environment-not-found',
    });
  });

  it('does NOT bootstrap when one or more valid Skills are discovered — preserves the existing safety boundary', async () => {
    const stackHome = await tempDir('stack-home-');
    const fakeHome = await useFakeHome();
    await seedValidSkill(fakeHome);

    const result = await bootstrapEmptyMainIfSkillFree({
      stackHome,
      dryRun: false,
    });

    expect(result).toBe('skipped');
    await expect(loadMainEnvironment({ stackHome })).rejects.toMatchObject({
      code: 'environment-not-found',
    });
  });

  it('is a no-op when main already exists, regardless of discovered Skills', async () => {
    const stackHome = await tempDir('stack-home-');
    await useFakeHome();
    // First call establishes an empty main (zero Skills).
    await bootstrapEmptyMainIfSkillFree({ stackHome, dryRun: false });
    const before = await loadMainEnvironment({ stackHome });

    const result = await bootstrapEmptyMainIfSkillFree({
      stackHome,
      dryRun: false,
    });

    expect(result).toBe('skipped');
    const after = await loadMainEnvironment({ stackHome });
    expect(after.manifest).toEqual(before.manifest);
  });
});

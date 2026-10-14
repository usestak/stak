import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyStoredSkill } from '@stack/store';

import { preserveTrialStack, resolveTrialStack } from './trial.js';

const directories: string[] = [];
const temp = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'stack-trial-core-'));
  directories.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});
const fixture = (...parts: string[]) =>
  path.resolve(process.cwd(), '..', '..', 'fixtures', 'staks', ...parts);

describe('trial Stack resolution', () => {
  it('resolves a directory or direct manifest without requiring main', async () => {
    const ids = () => '12345678';
    const directory = await resolveTrialStack({
      input: fixture('frontend'),
      idFactory: ids,
    });
    const manifest = await resolveTrialStack({
      input: fixture('frontend', 'stak.yaml'),
      idFactory: ids,
    });
    expect(directory.resolved.stackVersionHash).toBe(
      manifest.resolved.stackVersionHash,
    );
    expect(
      directory.resolved.environment.skills.map((skill) => skill.name),
    ).toEqual(['playwright', 'react', 'review']);
    expect(
      directory.resolved.environment.skills.every((skill) =>
        skill.entryId.startsWith('skill_trial_'),
      ),
    ).toBe(true);
  });

  it('reuses required/optional semantics and rejects internal required conflicts', async () => {
    const root = await temp();
    const bundle = path.join(root, 'conflict');
    await mkdir(bundle, { recursive: true });
    await writeFile(
      path.join(bundle, 'stak.yaml'),
      `schemaVersion: 1\nname: conflict\ndescription: conflict\nextends:\n  - ${JSON.stringify(fixture('base'))}\n  - ${JSON.stringify(fixture('required-conflict'))}\nskills: []\n`,
    );
    await expect(resolveTrialStack({ input: bundle })).rejects.toMatchObject({
      code: 'try-resolution-conflict',
    });
    const optional = await resolveTrialStack({
      input: fixture('optional-conflict'),
    });
    expect(optional.resolved.required).toBe(0);
    expect(optional.resolved.optionalIncluded).toBe(1);
  });

  it('keeps resolution dry and ingests exact immutable content only when requested', async () => {
    const stackHome = await temp();
    const trial = await resolveTrialStack({ input: fixture('frontend') });
    for (const skill of trial.resolved.environment.skills)
      expect(
        (await verifyStoredSkill({ stackHome, contentHash: skill.contentHash }))
          .state,
      ).toBe('missing');
    await preserveTrialStack({ stackHome, trial });
    for (const skill of trial.resolved.environment.skills)
      expect(
        (await verifyStoredSkill({ stackHome, contentHash: skill.contentHash }))
          .state,
      ).toBe('available');
  });
});

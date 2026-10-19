import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSkills } from '@stack/scanner';
import type { SkillRoot } from '@stack/spec';

import { StackCompositionError } from './stack-loader.js';
import { prepareSkillRemove, applySkillRemove } from './composition.js';
import { initializeMainEnvironment } from './initialize.js';
import { loadMainEnvironment } from './state.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-skill-remove-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const writeSkill = async (directory: string, name: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
  );
};

const claudeRoot = (directory: string): SkillRoot => ({
  path: directory,
  rootKind: 'claude',
  scope: 'global',
});

describe('prepareSkillRemove / applySkillRemove', () => {
  it('removes a direct Skill entry from main, even when missing on disk', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await writeSkill(path.join(home, 'beta'), 'beta');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    // Simulate the Skill having been deleted from disk — removal must still work.
    await rm(path.join(home, 'beta'), { recursive: true, force: true });

    const proposal = await prepareSkillRemove({ stackHome, selector: 'beta' });
    expect(proposal.name).toBe('beta');
    await applySkillRemove(proposal);

    const state = await loadMainEnvironment({ stackHome });
    const names = Object.values(state.lock.skills).map((s) => s.name);
    expect(names).toEqual(['alpha']);
  });

  it('throws not-found for an unknown selector', async () => {
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    await expect(
      prepareSkillRemove({ stackHome, selector: 'does-not-exist' }),
    ).rejects.toThrow(StackCompositionError);
  });
});

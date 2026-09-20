import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  initializeMainEnvironment,
  loadMainEnvironment,
  statusMainEnvironment,
} from '@stack/core';
import { scanSkills } from '@stack/scanner';
import { hashSkillDirectory } from '@stack/shared';
import type { SkillRoot } from '@stack/spec';
import { verifyStoredSkill } from '@stack/store';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-synced-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const writeSkill = async (directory: string, name: string, body = name) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n${body}\n`,
  );
};

const claudeRoot = (directory: string): SkillRoot => ({
  path: directory,
  rootKind: 'claude',
  scope: 'global',
});

const SYNCED_NAMES = [
  'docs',
  'docx',
  'import-memory',
  'morning',
  'pdf',
  'pptx',
  'skill-creator',
  'xlsx',
];

// Build a Claude root with 31 real, unique-content personal Skills plus 8
// account-synced Skills under the reserved `synced/` subtree.
const buildClaudeHome = async () => {
  const home = await temp();
  for (let index = 0; index < 31; index += 1)
    await writeSkill(path.join(home, `real-${index}`), `real-${index}`);
  const synced = path.join(home, 'synced', 'sync-id');
  for (const name of SYNCED_NAMES)
    await writeSkill(path.join(synced, name), name);
  return { home, synced };
};

describe('Claude account-synced Skill exclusion (init/status/snapshot)', () => {
  it('fresh init imports only the real Skills and never the synced subtree', async () => {
    const { home, synced } = await buildClaudeHome();
    const stackHome = await temp();

    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });
    expect(scanResult.summary.uniqueSkillContents).toBe(31);

    const result = await initializeMainEnvironment({ stackHome, scanResult });
    expect(result.importedSkills).toBe(31);

    // No synced Skill name leaked into the environment lock.
    const state = await loadMainEnvironment({ stackHome });
    const lockedNames = Object.values(state.lock.skills).map(
      (locked) => locked.name,
    );
    for (const name of SYNCED_NAMES) expect(lockedNames).not.toContain(name);

    // A synced Skill's content was never preserved into the Store (not a
    // snapshot candidate / cloud backup input).
    const syncedHash = (await hashSkillDirectory(path.join(synced, 'pdf')))
      .hash;
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: syncedHash })).state,
    ).toBe('missing');
  }, 30_000);

  it('status shows synced Skills as neither satisfied nor untracked', async () => {
    const { home } = await buildClaudeHome();
    const stackHome = await temp();

    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    // Re-scan the same tree (synced Skills still present on disk) and diff.
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    expect(status.summary.satisfied).toBe(31);
    expect(status.summary.untracked).toBe(0);
    expect(status.untracked).toHaveLength(0);
  }, 30_000);
});

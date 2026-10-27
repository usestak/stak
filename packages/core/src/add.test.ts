import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSkills } from '@stack/scanner';
import type { SkillRoot } from '@stack/spec';

import { applySkillAdd, prepareSkillAdd } from './add.js';
import { initializeMainEnvironment } from './initialize.js';
import { loadMainEnvironment } from './state.js';
import { applyStackUse, prepareStackUse } from './composition.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-add-'));
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

describe('prepareSkillAdd / applySkillAdd', () => {
  it('adds a brand-new untracked Skill to main', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');

    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    await writeSkill(path.join(home, 'beta'), 'beta');
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['beta'],
    });
    expect(proposal.issues).toHaveLength(0);
    expect(proposal.targets.map((t) => t.name)).toEqual(['beta']);
    expect(proposal.targets[0]?.kind).toBe('new');

    await applySkillAdd(proposal);

    const state = await loadMainEnvironment({ stackHome });
    const names = Object.values(state.lock.skills).map((s) => s.name);
    expect(names).toContain('beta');
    expect(names).toContain('alpha');
  });

  it('accepts a modified tracked Skill into the SAME logical entry', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha', 'version one');

    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const before = await loadMainEnvironment({ stackHome });
    const beforeEntryId = Object.keys(before.lock.skills)[0];
    expect(beforeEntryId).toBeDefined();

    await writeSkill(path.join(home, 'alpha'), 'alpha', 'version two');
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['alpha'],
    });
    expect(proposal.issues).toHaveLength(0);
    expect(proposal.targets[0]?.kind).toBe('modified');
    expect(proposal.targets[0]?.entryId).toBe(beforeEntryId);

    await applySkillAdd(proposal);

    const after = await loadMainEnvironment({ stackHome });
    expect(Object.keys(after.lock.skills)).toEqual([beforeEntryId]);
    const locked = after.lock.skills[beforeEntryId as string];
    expect(locked?.contentHash).not.toBe(
      before.lock.skills[beforeEntryId as string]?.contentHash,
    );
  });

  it('reports already-satisfied when content matches what is already tracked', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['alpha'],
    });
    expect(proposal.targets).toHaveLength(0);
    expect(proposal.issues).toEqual([
      { status: 'already-satisfied', selector: 'alpha', name: 'alpha' },
    ]);
  });

  it('fails closed with ambiguous candidates for a colliding name', async () => {
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    await writeSkill(path.join(home, 'one', 'gamma'), 'gamma', 'one');
    await writeSkill(path.join(home, 'two', 'gamma'), 'gamma', 'two');
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['gamma'],
    });
    expect(proposal.targets).toHaveLength(0);
    expect(proposal.issues).toHaveLength(1);
    expect(proposal.issues[0]?.status).toBe('ambiguous');
  });

  it('rejects an invalid Skill by name', async () => {
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    await mkdir(path.join(home, 'bad'), { recursive: true });
    await writeFile(
      path.join(home, 'bad', 'SKILL.md'),
      '---\nname: bad\n---\n\nmissing description\n',
    );
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['bad'],
    });
    expect(proposal.targets).toHaveLength(0);
    expect(proposal.issues[0]?.status).toBe('invalid');
  });

  it('reports not-found for an unknown selector', async () => {
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['does-not-exist'],
    });
    expect(proposal.issues).toEqual([
      { status: 'not-found', selector: 'does-not-exist' },
    ]);
  });

  it('fails closed on a name collision between a tracked STAK-layer Skill and new untracked content', async () => {
    // A STAK-layer-sourced Skill's baseline never records a physical on-disk location (its
    // content lives in the Store, not at a tracked path), so a second directory sharing its
    // declared name is a genuine name collision (two different Skills, same name), not a
    // "modified" edit of the tracked one. `add` must fail closed rather than silently
    // creating a second, conflicting manifest entry or silently preferring either side.
    const home = await temp();
    const stackHome = await temp();
    const stackDir = await temp();
    await writeSkill(path.join(stackDir, 'delta'), 'delta', 'layer version');
    await writeFile(
      path.join(stackDir, 'stak.yaml'),
      'schemaVersion: 1\nname: layer-stack\ndescription: layer stack\nskills:\n  - path: delta\n    requirement: required\n',
    );

    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const useProposal = await prepareStackUse({ stackHome, input: stackDir });
    await applyStackUse(useProposal);

    await writeSkill(path.join(home, 'delta'), 'delta', 'local edit');
    const scanResult = await scanSkills({
      roots: [claudeRoot(home), claudeRoot(stackDir)],
    });

    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: ['delta'],
    });
    expect(proposal.targets).toHaveLength(0);
    expect(proposal.issues[0]?.status).toBe('ambiguous');
  });
});

describe('prepareSkillAdd — add-all (.) semantics', () => {
  it('stages all untracked and all direct-modified Skills, leaves missing alone', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha', 'v1');
    await writeSkill(path.join(home, 'gone'), 'gone');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    // alpha: modify in place. gone: delete from disk. new-one: brand new.
    await writeSkill(path.join(home, 'alpha'), 'alpha', 'v2');
    await rm(path.join(home, 'gone'), { recursive: true, force: true });
    await writeSkill(path.join(home, 'new-one'), 'new-one');

    const scanResult = await scanSkills({ roots: [claudeRoot(home)] });
    const proposal = await prepareSkillAdd({
      stackHome,
      scanResult,
      selectors: '.',
    });
    const names = proposal.targets.map((t) => t.name).sort();
    expect(names).toEqual(['alpha', 'new-one']);

    await applySkillAdd(proposal);
    const state = await loadMainEnvironment({ stackHome });
    const lockedNames = Object.values(state.lock.skills).map((s) => s.name);
    expect(lockedNames).toContain('new-one');
    // "gone" remains tracked in main (missing on disk) — add . must never remove it.
    expect(lockedNames).toContain('gone');
  });
});

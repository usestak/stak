import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { ResolvedLocalEnvironment } from '@stack/spec';
import { contentObjectPaths, ingestSkill } from '@stack/store';

import { CodexAdapter } from './index.js';

// This proves the SAME fail-closed guarantee already covered at the Store
// unit-test level (packages/store/src/store.test.ts) holds at the actual
// integration point `stak skill update` calls through: the Codex adapter's
// `applyBindings` (packages/adapters/src/codex.ts), which calls
// `materializeStoredSkill` (around codex.ts:475) to copy approved Skill
// content from the content-addressed Store onto disk at the agent's target
// location.

const temporaryDirectories: string[] = [];
const temp = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'stak-apply-integrity-'));
  temporaryDirectories.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});

const createStoredSkill = async (stackHome: string, name: string) => {
  const source = path.join(await temp(), name);
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\noriginal content\n`,
  );
  const contentHash = (await hashSkillDirectory(source)).hash;
  await ingestSkill({
    stackHome,
    sourcePath: source,
    expectedContentHash: contentHash,
  });
  return { source, contentHash };
};

const environment = (
  machineId: string,
  skills: ResolvedLocalEnvironment['skills'],
): ResolvedLocalEnvironment => ({ name: 'main', machineId, skills });

describe('local apply — content-hash integrity (P5a proof)', () => {
  it('fails closed and projects NOTHING when the stored object has been corrupted on disk', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const machineId = '00000000-0000-4000-8000-000000000000';
    const desired = environment(machineId, [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);

    // Plan while the store is still intact, so the plan is a legitimate
    // 'add' (not blocked by planBindings' own pre-flight verification).
    const plan = await adapter.planBindings(desired);
    expect(plan.operations[0]?.state).toBe('add');
    expect(plan.blocking).toBe(false);

    // Corrupt the STORED object's content directly on disk, bypassing
    // ingestSkill entirely, so the on-disk bytes no longer match the
    // contentHash the plan/registry/caller believe are approved.
    const { contentPath } = contentObjectPaths(stackHome, stored.contentHash);
    await writeFile(
      path.join(contentPath, 'SKILL.md'),
      `---\nname: demo\ndescription: demo\n---\ntampered content\n`,
    );

    const target = path.join(homeDir, '.agents', 'skills', 'demo');

    // The real local-apply entry point `stak skill update` goes through —
    // FilesystemSkillAdapter.applyBindings, which calls
    // materializeStoredSkill at the operation's materialize step.
    await expect(
      adapter.applyBindings(plan, desired.machineId),
    ).rejects.toThrow();

    // Fail-closed means nothing was projected to the target location, not
    // merely that an error was thrown: the target must either not exist at
    // all, or (if something created the directory) be empty.
    let targetExists = true;
    try {
      await access(target);
    } catch {
      targetExists = false;
    }
    if (targetExists) {
      const entries = await readdir(target);
      expect(entries).toHaveLength(0);
    } else {
      expect(targetExists).toBe(false);
    }
  });
});

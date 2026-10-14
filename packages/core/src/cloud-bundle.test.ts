import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { ScanResult } from '@stack/spec';

import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import {
  applyStackUse,
  prepareStackUse,
  setSkillPaused,
} from './composition.js';
import { initializeMainEnvironment } from './initialize.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-bundle-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const seedMain = async (
  stackHome: string,
  sourcesDir: string,
  names: string[],
) => {
  const seeded: { name: string; dir: string; hash: string }[] = [];
  for (const name of names) {
    const dir = path.join(sourcesDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n${name}\n`,
    );
    seeded.push({ name, dir, hash: (await hashSkillDirectory(dir)).hash });
  }
  const scanResult: ScanResult = {
    roots: [
      {
        path: sourcesDir,
        rootKind: 'agents',
        scope: 'global',
        status: 'scanned',
        skillLocations: seeded.length,
      },
    ],
    skills: seeded.map((item) => ({
      contentHash: item.hash,
      metadata: { name: item.name, description: `${item.name} skill` },
      valid: true,
      source: { type: 'local' as const },
      locations: [
        {
          path: item.dir,
          rootKind: 'agents' as const,
          scope: 'global' as const,
          rootPath: sourcesDir,
          isSymlink: false,
          realPath: item.dir,
          source: { type: 'local' as const },
        },
      ],
    })),
    nameCollisions: [],
    diagnostics: [],
    summary: {
      roots: { scanned: 1, missing: 0, failed: 0 },
      uniqueSkillContents: seeded.length,
      locations: seeded.length,
      validSkills: seeded.length,
      invalidSkills: 0,
      exactDuplicateContents: 0,
      nameCollisions: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      provenance: { git: 0, local: seeded.length, unknown: 0 },
    },
  };
  await initializeMainEnvironment({ stackHome, scanResult });
  return seeded;
};

const seedLayer = async (stackHome: string, stackDir: string, name: string) => {
  await mkdir(path.join(stackDir, 'skills', name), { recursive: true });
  await writeFile(
    path.join(stackDir, 'stak.yaml'),
    `schemaVersion: 1\nname: ${name}-stack\ndescription: ${name} stack\nskills:\n  - path: skills/${name}\n    requirement: required\n`,
  );
  await writeFile(
    path.join(stackDir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
  );
  await applyStackUse(await prepareStackUse({ stackHome, input: stackDir }));
};

describe('cloud environment bundle', () => {
  it('produces a deterministic digest across rebuilds', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome, path.join(root, 'src'), ['foo', 'bar']);
    const first = await buildCloudEnvironmentBundle({ stackHome });
    const second = await buildCloudEnvironmentBundle({ stackHome });
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('carries desired pause state into the bundle and reflects it in the digest (P3)', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome, path.join(root, 'src'), ['foo', 'bar']);
    const before = await buildCloudEnvironmentBundle({ stackHome });
    const fooEntry = Object.entries(before.resolved.skills).find(
      ([, skill]) => skill.name === 'foo',
    );
    expect(fooEntry).toBeDefined();
    const fooId = fooEntry?.[0] ?? '';
    expect(before.resolved.skills[fooId]?.paused).toBeUndefined();

    await setSkillPaused({ stackHome, selector: 'foo', paused: true });
    const after = await buildCloudEnvironmentBundle({ stackHome });
    expect(after.resolved.skills[fooId]?.paused).toBe(true);
    // Pause is part of the desired-state identity, so the digest moves when it changes.
    expect(after.digest).not.toBe(before.digest);
  });

  it('normalizes snapshot restorations to content hashes without local ids', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome, path.join(root, 'src'), ['foo']);
    const bundle = await buildCloudEnvironmentBundle({ stackHome });
    const skills = Object.values(bundle.resolved.skills);
    expect(skills.length).toBe(1);
    expect(skills[0]?.restoration.strategy).toBe('snapshot');
    expect(JSON.stringify(bundle)).not.toContain('snap_');
    expect(JSON.stringify(bundle)).not.toContain('snapshotId');
  });

  it('includes imported Stack versions and preserves portable ids', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome, path.join(root, 'src'), ['foo']);
    await seedLayer(stackHome, path.join(root, 'frontend'), 'design');
    const bundle = await buildCloudEnvironmentBundle({ stackHome });
    expect(bundle.importedStackVersions.length).toBe(1);
    expect(
      bundle.importedStackVersions[0]?.requirements.length,
    ).toBeGreaterThan(0);
    // Manifest layer references match imported version stack ids.
    const layer = bundle.environment.stacks[0];
    expect(layer).toBeDefined();
    expect(bundle.importedStackVersions[0]?.stackId).toBe(layer?.stackId);
    // Every manifest Skill entry id appears in the resolved lock.
    for (const entry of bundle.environment.skills)
      expect(bundle.resolved.skills[entry.id]).toBeDefined();
  });

  it('never serializes Machine paths, home dirs, or credentials', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome, path.join(root, 'src'), ['foo', 'bar']);
    await seedLayer(stackHome, path.join(root, 'frontend'), 'design');
    const serialized = JSON.stringify(
      await buildCloudEnvironmentBundle({ stackHome }),
    );
    for (const forbidden of [
      stackHome,
      path.join(root, 'src'),
      root,
      'auth.json',
      '.stack',
      tmpdir(),
    ])
      expect(serialized).not.toContain(forbidden.replace(/\\/g, '\\\\'));
    expect(serialized).not.toContain(stackHome);
  });
});

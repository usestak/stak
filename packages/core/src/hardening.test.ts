import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScanResult } from '@stack/spec';

import { applyStackUse, prepareStackUse } from './composition.js';
import { initializeMainEnvironment } from './initialize.js';
import {
  StackStateError,
  getOrCreateMachineIdentity,
  loadMainEnvironment,
} from './state.js';
import { StackCompositionError } from './stack-loader.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-harden-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const emptyScan = (): ScanResult => ({
  roots: [
    {
      path: '/tmp/none',
      rootKind: 'agents',
      scope: 'global',
      status: 'scanned',
      skillLocations: 0,
    },
  ],
  skills: [],
  nameCollisions: [],
  diagnostics: [],
  summary: {
    roots: { scanned: 1, missing: 0, failed: 0 },
    uniqueSkillContents: 0,
    locations: 0,
    validSkills: 0,
    invalidSkills: 0,
    exactDuplicateContents: 0,
    nameCollisions: 0,
    diagnostics: { errors: 0, warnings: 0, info: 0 },
    provenance: { git: 0, local: 0, unknown: 0 },
  },
});

const seedMain = async (stackHome: string) => {
  await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
};

const paths = (stackHome: string) => ({
  machine: path.join(stackHome, 'machine.json'),
  manifest: path.join(stackHome, 'environments', 'main', 'environment.yaml'),
  lock: path.join(stackHome, 'environments', 'main', 'stack.lock.json'),
  lockfile: path.join(stackHome, 'environments', '.main.mutation.lock'),
});

describe('state hardening', () => {
  it('rejects state written by a newer schema version without resetting', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome);
    const machine = JSON.parse(
      await readFile(paths(stackHome).machine, 'utf8'),
    );
    await writeFile(
      paths(stackHome).machine,
      JSON.stringify({ ...machine, schemaVersion: 2 }, null, 2),
    );
    await expect(loadMainEnvironment({ stackHome })).rejects.toMatchObject({
      code: 'invalid-state',
    });
    await expect(loadMainEnvironment({ stackHome })).rejects.toThrow(
      /newer version of Stack/i,
    );
  });

  it('fails clearly on corrupt manifest YAML (no silent reset)', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome);
    await writeFile(paths(stackHome).manifest, 'not: [valid yaml: : :\n');
    const error = await loadMainEnvironment({ stackHome }).catch((e) => e);
    expect(error).toBeInstanceOf(StackStateError);
    expect(error.code).toBe('invalid-state');
  });

  it('fails clearly on corrupt lock JSON', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome);
    await writeFile(paths(stackHome).lock, '{ this is not json');
    await expect(loadMainEnvironment({ stackHome })).rejects.toBeInstanceOf(
      StackStateError,
    );
  });

  it('rejects a corrupt machine identity instead of creating a new one', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await mkdir(stackHome, { recursive: true });
    await writeFile(path.join(stackHome, 'machine.json'), 'garbage');
    await expect(
      getOrCreateMachineIdentity({ stackHome }),
    ).rejects.toBeInstanceOf(StackStateError);
  });

  it('blocks a mutation when the cross-process main lock is held', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    await seedMain(stackHome);
    const stackDir = path.join(root, 'frontend');
    await mkdir(path.join(stackDir, 'skills', 'design'), { recursive: true });
    await writeFile(
      path.join(stackDir, 'stak.yaml'),
      'schemaVersion: 1\nname: frontend\ndescription: Frontend\nskills:\n  - path: skills/design\n    requirement: required\n',
    );
    await writeFile(
      path.join(stackDir, 'skills', 'design', 'SKILL.md'),
      '---\nname: design\ndescription: d\n---\nbody\n',
    );
    const proposal = await prepareStackUse({ stackHome, input: stackDir });
    // Simulate another live process holding the main mutation lock.
    await writeFile(paths(stackHome).lockfile, `${process.pid}\n`, {
      flag: 'wx',
    });
    const error = await applyStackUse(proposal).catch((e) => e);
    expect(error).toBeInstanceOf(StackCompositionError);
    expect(error.code).toBe('environment-mutation-in-progress');
  });
});

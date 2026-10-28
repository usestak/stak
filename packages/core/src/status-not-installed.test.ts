/**
 * `not-installed` vs `missing` in `statusMainEnvironment`.
 *
 * A Skill tracked in `main` but absent from every agent root is `missing` only when this
 * machine has evidence it was placed here: a baseline placement (captured by `init`/`add`)
 * or an agent binding for that exact content (written by `stak run <agent>`). Without that
 * evidence — the state `stak pull` leaves on a new machine — it is `not-installed`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { ScanResult } from '@stack/spec';

import { initializeMainEnvironment } from './initialize.js';
import { loadMainEnvironment, statePaths } from './state.js';
import { statusMainEnvironment } from './status.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  ),
);

const emptyScan = (rootPath: string): ScanResult => ({
  roots: [
    {
      path: rootPath,
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

/** A main with one Skill `alpha`, captured from a real directory that is then deleted. */
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stak-not-installed-'));
  directories.push(root);
  const stackHome = path.join(root, 'stak');
  const skillsRoot = path.join(root, 'skills');
  const dir = path.join(skillsRoot, 'alpha');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: alpha\ndescription: alpha skill\n---\nalpha\n',
  );
  const contentHash = (await hashSkillDirectory(dir)).hash;
  const scan = emptyScan(skillsRoot);
  await initializeMainEnvironment({
    stackHome,
    scanResult: {
      ...scan,
      skills: [
        {
          contentHash,
          metadata: { name: 'alpha', description: 'alpha skill' },
          valid: true,
          source: { type: 'local' },
          locations: [
            {
              path: dir,
              rootPath: skillsRoot,
              rootKind: 'agents',
              scope: 'global',
              isSymlink: false,
              realPath: dir,
              source: { type: 'local' },
            },
          ],
        },
      ],
    },
  });
  await rm(dir, { recursive: true, force: true });
  const state = await loadMainEnvironment({ stackHome });
  const [entryId] = Object.keys(state.lock.skills);
  if (!entryId) throw new Error('expected one Skill in main');
  const machineId = state.machine.machineId;
  return { stackHome, scan, entryId, contentHash, machineId };
};

/** Make the baseline look like a fresh `stak pull`: no placements on this machine. */
const clearPlacements = async (stackHome: string, machineId: string) => {
  const state = await loadMainEnvironment({ stackHome });
  const baseline = {
    ...state.baseline,
    skills: Object.fromEntries(
      Object.entries(state.baseline.skills).map(([id, entry]) => [
        id,
        { ...entry, locations: [] },
      ]),
    ),
  };
  await writeFile(
    statePaths(stackHome, machineId).baseline,
    `${JSON.stringify(baseline, null, 2)}\n`,
  );
};

const writeBindings = async (
  stackHome: string,
  machineId: string,
  body: string,
) => {
  const file = path.join(
    stackHome,
    'state',
    'machines',
    machineId,
    'bindings.json',
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

const binding = (entryId: string, contentHash: string) => ({
  environment: 'main',
  environmentEntryId: entryId,
  skillName: 'alpha',
  contentHash,
  targetPath: '/home/user/.agents/skills/alpha',
  targetRoot: 'agents',
  createdAt: new Date(0).toISOString(),
});

describe('statusMainEnvironment: not-installed vs missing', () => {
  it('reports missing when the Skill was captured on this machine and then deleted', async () => {
    const { stackHome, scan } = await setup();
    const status = await statusMainEnvironment({ stackHome, scanResult: scan });
    expect(status.skills[0]?.state).toBe('missing');
    expect(status.summary).toMatchObject({ missing: 1, notInstalled: 0 });
  });

  it('reports not-installed when this machine has no placement and no binding for it', async () => {
    const { stackHome, scan, machineId } = await setup();
    await clearPlacements(stackHome, machineId);
    const status = await statusMainEnvironment({ stackHome, scanResult: scan });
    expect(status.skills[0]?.state).toBe('not-installed');
    expect(status.summary).toMatchObject({ missing: 0, notInstalled: 1 });
  });

  it('reports missing when `stak run` bound this exact content here and it is gone', async () => {
    const { stackHome, scan, machineId, entryId, contentHash } = await setup();
    await clearPlacements(stackHome, machineId);
    await writeBindings(
      stackHome,
      machineId,
      JSON.stringify({
        schemaVersion: 1,
        machineId,
        bindings: [binding(entryId, contentHash)],
      }),
    );
    const status = await statusMainEnvironment({ stackHome, scanResult: scan });
    expect(status.skills[0]?.state).toBe('missing');
  });

  it('reports not-installed when only an older version was bound here (main moved on)', async () => {
    const { stackHome, scan, machineId, entryId } = await setup();
    await clearPlacements(stackHome, machineId);
    await writeBindings(
      stackHome,
      machineId,
      JSON.stringify({
        schemaVersion: 1,
        machineId,
        bindings: [binding(entryId, `sha256:${'e'.repeat(64)}`)],
      }),
    );
    const status = await statusMainEnvironment({ stackHome, scanResult: scan });
    expect(status.skills[0]?.state).toBe('not-installed');
  });

  it('treats an unreadable binding registry as no bindings (never escalates to missing)', async () => {
    const { stackHome, scan, machineId } = await setup();
    await clearPlacements(stackHome, machineId);
    await writeBindings(stackHome, machineId, '{ not json');
    const status = await statusMainEnvironment({ stackHome, scanResult: scan });
    expect(status.skills[0]?.state).toBe('not-installed');
  });
});

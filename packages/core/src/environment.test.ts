import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  DiscoveredSkill,
  ScanResult,
  SkillLocation,
  SkillRootKind,
  SkillSource,
} from '@stack/spec';
import type { StoreVerification } from '@stack/spec';
import type { IngestSkillOptions, IngestSkillResult } from '@stack/store';
import { hashSkillDirectory } from '@stack/shared';
import {
  contentObjectPaths,
  materializeStoredSkill,
  verifyStoredSkill,
} from '@stack/store';
import {
  environmentLockSchema,
  environmentManifestSchema,
  machineEnvironmentBaselineSchema,
  machineIdentitySchema,
} from '@stack/spec';

import {
  diffMainEnvironment as realDiffMainEnvironment,
  getOrCreateMachineIdentity,
  initializeMainEnvironment as realInitializeMainEnvironment,
  loadMainEnvironment,
  resolveStackHome,
  statusMainEnvironment as realStatusMainEnvironment,
} from './index.js';

const temporaryDirectories: string[] = [];
const temp = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stack-core-'));
  temporaryDirectories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const location = (
  rootPath: string,
  name: string,
  rootKind: SkillRootKind = 'codex',
  source: SkillSource = { type: 'local' },
): SkillLocation => ({
  path: path.join(rootPath, name),
  rootPath,
  rootKind,
  scope: 'global',
  isSymlink: false,
  source,
});
const skill = (
  rootPath: string,
  name: string,
  contentHash: string,
  options: {
    locations?: SkillLocation[];
    valid?: boolean;
    source?: SkillSource;
  } = {},
): DiscoveredSkill => ({
  contentHash,
  ...(options.valid === false
    ? {}
    : { metadata: { name, description: `${name} description` } }),
  valid: options.valid !== false,
  source: options.source ?? { type: 'local' },
  locations: options.locations ?? [
    location(rootPath, name, 'codex', options.source ?? { type: 'local' }),
  ],
});
const scan = (
  skills: DiscoveredSkill[],
  options: { failedRoot?: string; projectSkill?: DiscoveredSkill } = {},
): ScanResult => {
  const globalRoot =
    skills.flatMap((item) => item.locations)[0]?.rootPath ?? '/global';
  const all = options.projectSkill ? [...skills, options.projectSkill] : skills;
  const roots: ScanResult['roots'] = [
    {
      path: globalRoot,
      rootKind: 'codex',
      scope: 'global',
      status: 'scanned',
      skillLocations: skills.length,
    },
  ];
  if (options.failedRoot)
    roots.push({
      path: options.failedRoot,
      rootKind: 'cursor',
      scope: 'global',
      status: 'failed',
      skillLocations: 0,
      error: 'denied',
    });
  return {
    roots,
    skills: all,
    nameCollisions: [],
    diagnostics: [],
    summary: {
      roots: {
        scanned: 1,
        missing: 0,
        failed: options.failedRoot ? 1 : 0,
      },
      uniqueSkillContents: all.length,
      locations: all.reduce((count, item) => count + item.locations.length, 0),
      validSkills: all.filter((item) => item.valid).length,
      invalidSkills: all.filter((item) => !item.valid).length,
      exactDuplicateContents: all.filter((item) => item.locations.length > 1)
        .length,
      nameCollisions: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      provenance: { git: 0, local: all.length, unknown: 0 },
    },
  };
};
const fixedNow = () => new Date('2026-09-19T12:00:00.000Z');
let idCounter = 0;
const fixedId = () =>
  `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;
const testStore = {
  ingestSkill: async (
    options: IngestSkillOptions,
  ): Promise<IngestSkillResult> => ({
    contentHash: options.expectedContentHash,
    objectPath: path.join(
      options.stackHome,
      'store',
      options.expectedContentHash,
    ),
    contentPath: path.join(
      options.stackHome,
      'store',
      options.expectedContentHash,
      'content',
    ),
    reused: false,
  }),
  verifyStoredSkill: async (options: {
    contentHash: string;
  }): Promise<StoreVerification> => ({
    state: 'available' as const,
    contentHash: options.contentHash,
  }),
};
const initializeMainEnvironment = (
  options: Parameters<typeof realInitializeMainEnvironment>[0],
) => realInitializeMainEnvironment({ ...options, store: testStore });
const statusMainEnvironment = (
  options: Parameters<typeof realStatusMainEnvironment>[0],
) => realStatusMainEnvironment({ ...options, store: testStore });
const diffMainEnvironment = (
  options: Parameters<typeof realDiffMainEnvironment>[0],
) => realDiffMainEnvironment({ ...options, store: testStore });

describe('Machine identity and paths', () => {
  it('respects STACK_HOME and keeps a stable random identity', async () => {
    const directory = await temp();
    expect(resolveStackHome({ env: { STACK_HOME: directory } })).toBe(
      path.resolve(directory),
    );
    const first = await getOrCreateMachineIdentity({
      stackHome: directory,
      now: fixedNow,
      idFactory: fixedId,
      platform: 'win32',
      arch: 'x64',
    });
    const second = await getOrCreateMachineIdentity({ stackHome: directory });
    expect(second).toEqual(first);
    expect(
      machineIdentitySchema.parse(
        JSON.parse(
          await readFile(path.join(directory, 'machine.json'), 'utf8'),
        ),
      ),
    ).toEqual(first);
  });
});

describe('initializeMainEnvironment', () => {
  it('writes portable manifest/lock and machine-specific duplicate placements', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const firstRoot = path.join(stackHome, 'machine', '.codex', 'skills');
    const secondRoot = path.join(stackHome, 'machine', '.cursor', 'skills');
    const gitSource: SkillSource = {
      type: 'git',
      remote: 'https://example.test/repo.git',
      revision: 'abc123',
      path: 'skills/design',
    };
    const duplicate = skill(firstRoot, 'design', hash('a'), {
      source: gitSource,
      locations: [
        location(firstRoot, 'design', 'codex', gitSource),
        location(secondRoot, 'design-copy', 'cursor', { type: 'unknown' }),
      ],
    });
    const collision = skill(firstRoot, 'design', hash('b'));
    const invalid = skill(firstRoot, 'broken', hash('c'), { valid: false });
    const project = skill(
      path.join(stackHome, 'project'),
      'project-only',
      hash('d'),
      {
        locations: [
          {
            ...location(path.join(stackHome, 'project'), 'project-only'),
            scope: 'project',
          },
        ],
      },
    );

    const result = await initializeMainEnvironment({
      stackHome,
      scanResult: scan([duplicate, collision, invalid], {
        projectSkill: project,
      }),
      now: fixedNow,
      idFactory: fixedId,
      platform: 'win32',
      arch: 'x64',
    });
    const state = await loadMainEnvironment({ stackHome });

    expect(result).toMatchObject({
      importedSkills: 2,
      excludedInvalid: 1,
      excludedProject: 1,
      physicalLocations: 3,
      consolidatedDuplicates: 1,
      nameCollisions: 1,
    });
    expect(state.manifest.skills).toHaveLength(2);
    expect(state.manifest.skills.map((entry) => entry.name)).toEqual([
      'design',
      'design',
    ]);
    expect(JSON.stringify(state.manifest)).not.toContain(stackHome);
    expect(JSON.stringify(state.lock)).not.toContain(stackHome);
    expect(Object.values(state.baseline.skills)[0]?.locations).toHaveLength(2);
    expect(
      Object.values(state.baseline.skills)[0]?.locations[0]?.path,
    ).toContain(stackHome);
    expect(environmentManifestSchema.parse(state.manifest)).toEqual(
      state.manifest,
    );
    expect(environmentLockSchema.parse(state.lock)).toEqual(state.lock);
    expect(machineEnvironmentBaselineSchema.parse(state.baseline)).toEqual(
      state.baseline,
    );
    const locked = Object.values(state.lock.skills).find(
      (entry) => entry.contentHash === hash('a'),
    );
    expect(locked?.preferredSource).toEqual(gitSource);
    expect(locked?.observedSources).toHaveLength(2);
  });

  it('includes valid local and unknown Skills but excludes invalid and project Skills', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const root = path.join(stackHome, 'root');
    await initializeMainEnvironment({
      stackHome,
      scanResult: scan([
        skill(root, 'local', hash('a')),
        skill(root, 'unknown', hash('b'), { source: { type: 'unknown' } }),
        skill(root, 'invalid', hash('c'), { valid: false }),
      ]),
      now: fixedNow,
      idFactory: fixedId,
    });
    expect(
      (await loadMainEnvironment({ stackHome })).manifest.skills.map(
        (entry) => entry.name,
      ),
    ).toEqual(['local', 'unknown']);
  });

  it('does not leak a machine-local Git remote into the portable lock', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const root = path.join(stackHome, 'machine', 'repo', 'skills');
    const localGit: SkillSource = {
      type: 'git',
      remote: path.join(stackHome, 'machine', 'repo'),
      revision: 'abc123',
      path: 'skills/one',
    };
    await initializeMainEnvironment({
      stackHome,
      scanResult: scan([skill(root, 'one', hash('a'), { source: localGit })]),
      now: fixedNow,
      idFactory: fixedId,
    });
    const locked = Object.values(
      (await loadMainEnvironment({ stackHome })).lock.skills,
    )[0];
    expect(locked?.preferredSource).toEqual({
      type: 'git',
      revision: 'abc123',
      path: 'skills/one',
    });
    expect(JSON.stringify(locked)).not.toContain(stackHome);
  });

  it('refuses to overwrite main', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const input = {
      stackHome,
      scanResult: scan([]),
      now: fixedNow,
      idFactory: fixedId,
    };
    await initializeMainEnvironment(input);
    await expect(initializeMainEnvironment(input)).rejects.toMatchObject({
      code: 'environment-exists',
    });
  });

  it('refuses to initialize from an incomplete global scan', async () => {
    const stackHome = await temp();
    await expect(
      initializeMainEnvironment({
        stackHome,
        scanResult: scan([], { failedRoot: path.join(stackHome, 'failed') }),
      }),
    ).rejects.toMatchObject({ code: 'incomplete-scan' });
    await expect(
      stat(path.join(stackHome, 'machine.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose a partial main when persistence fails', async () => {
    idCounter = 0;
    const stackHome = await temp();
    await mkdir(stackHome, { recursive: true });
    await writeFile(path.join(stackHome, 'state'), 'blocks baseline directory');
    await expect(
      initializeMainEnvironment({
        stackHome,
        scanResult: scan([]),
        now: fixedNow,
        idFactory: fixedId,
      }),
    ).rejects.toBeTruthy();
    await expect(
      stat(path.join(stackHome, 'environments', 'main')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('produces deterministic portable resolution for equivalent input', async () => {
    const root = path.join(await temp(), 'root');
    const input = scan([
      skill(root, 'one', hash('a')),
      skill(root, 'two', hash('b')),
    ]);
    const firstHome = await temp();
    idCounter = 0;
    await initializeMainEnvironment({
      stackHome: firstHome,
      scanResult: input,
      now: fixedNow,
      idFactory: fixedId,
    });
    const first = await loadMainEnvironment({ stackHome: firstHome });
    const secondHome = await temp();
    idCounter = 0;
    await initializeMainEnvironment({
      stackHome: secondHome,
      scanResult: input,
      now: fixedNow,
      idFactory: fixedId,
    });
    const second = await loadMainEnvironment({ stackHome: secondHome });
    expect(second.manifest).toEqual(first.manifest);
    expect(second.lock).toEqual(first.lock);
  });
});

describe('status and diff', () => {
  const initialize = async (initial: ScanResult) => {
    idCounter = 0;
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: initial,
      now: fixedNow,
      idFactory: fixedId,
    });
    return stackHome;
  };

  it('reports an unchanged Machine as satisfied', async () => {
    const root = path.join(await temp(), 'skills');
    const current = scan([skill(root, 'one', hash('a'))]);
    const stackHome = await initialize(current);
    expect(
      (
        await statusMainEnvironment({
          stackHome,
          scanResult: current,
          now: fixedNow,
        })
      ).summary,
    ).toMatchObject({ satisfied: 1, modified: 0, missing: 0, untracked: 0 });
  });

  it('keeps a logical duplicate satisfied when one placement is removed', async () => {
    const base = await temp();
    const codex = path.join(base, 'codex');
    const cursor = path.join(base, 'cursor');
    const initialSkill = skill(codex, 'one', hash('a'), {
      locations: [location(codex, 'one'), location(cursor, 'one', 'cursor')],
    });
    const stackHome = await initialize(scan([initialSkill]));
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: scan([skill(codex, 'one', hash('a'))]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      satisfied: 1,
      missing: 0,
      placementRemoved: 1,
    });
  });

  it('classifies final deletion, in-place edits, new Skills, and duplicate additions', async () => {
    const base = await temp();
    const root = path.join(base, 'codex');
    const initial = scan([skill(root, 'one', hash('a'))]);

    const missingHome = await initialize(initial);
    expect(
      (
        await statusMainEnvironment({
          stackHome: missingHome,
          scanResult: scan([]),
          now: fixedNow,
        })
      ).summary.missing,
    ).toBe(1);

    const modifiedHome = await initialize(initial);
    const modified = await statusMainEnvironment({
      stackHome: modifiedHome,
      scanResult: scan([
        skill(root, 'renamed-metadata', hash('b'), {
          locations: [location(root, 'one')],
        }),
      ]),
      now: fixedNow,
    });
    expect(modified.summary).toMatchObject({ modified: 1, untracked: 0 });
    expect(modified.skills[0]?.currentHash).toBe(hash('b'));

    const addedHome = await initialize(initial);
    const added = await statusMainEnvironment({
      stackHome: addedHome,
      scanResult: scan([
        skill(root, 'one', hash('a')),
        skill(root, 'new', hash('c')),
      ]),
      now: fixedNow,
    });
    expect(added.summary.untracked).toBe(1);

    const duplicateHome = await initialize(initial);
    const duplicate = skill(root, 'one', hash('a'), {
      locations: [
        location(root, 'one'),
        location(path.join(base, 'cursor'), 'one', 'cursor'),
      ],
    });
    const duplicateStatus = await statusMainEnvironment({
      stackHome: duplicateHome,
      scanResult: scan([duplicate]),
      now: fixedNow,
    });
    expect(duplicateStatus.summary).toMatchObject({
      untracked: 0,
      placementAdded: 1,
    });
  });

  it('does not equate a same-name new Skill with desired identity', async () => {
    const base = await temp();
    const oldRoot = path.join(base, 'old');
    const newRoot = path.join(base, 'new');
    const stackHome = await initialize(
      scan([skill(oldRoot, 'same', hash('a'))]),
    );
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: scan([skill(newRoot, 'same', hash('b'))]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      missing: 1,
      modified: 0,
      untracked: 1,
    });
  });

  it('reports invalid discovered Skills separately from untracked Skills', async () => {
    const root = path.join(await temp(), 'skills');
    const initial = scan([skill(root, 'one', hash('a'))]);
    const stackHome = await initialize(initial);
    const current = scan([
      skill(root, 'one', hash('a')),
      skill(root, 'broken', hash('b'), { valid: false }),
    ]);
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: current,
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({ invalid: 1, untracked: 0 });
  });

  it('uses baseline location evidence when an in-place edit becomes invalid', async () => {
    const root = path.join(await temp(), 'skills');
    const initial = scan([skill(root, 'one', hash('a'))]);
    const stackHome = await initialize(initial);
    const broken = skill(root, 'one', hash('b'), {
      valid: false,
      locations: [location(root, 'one')],
    });
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: scan([broken]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({ modified: 1, invalid: 1 });
  });

  it('reports failed-root uncertainty instead of false missing', async () => {
    const base = await temp();
    const failedRoot = path.join(base, 'cursor');
    const initialSkill = skill(failedRoot, 'one', hash('a'), {
      locations: [location(failedRoot, 'one', 'cursor')],
    });
    const stackHome = await initialize(scan([initialSkill]));
    const current = scan([], { failedRoot });
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: current,
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      uncertain: 1,
      missing: 0,
      rootFailures: 1,
    });
  });

  it('reports a changed resolved symlink target as placement drift', async () => {
    const root = path.join(await temp(), 'skills');
    const visible = location(root, 'one');
    const initialSkill = skill(root, 'one', hash('a'), {
      locations: [
        {
          ...visible,
          isSymlink: true,
          realPath: path.join(root, 'targets', 'first'),
        },
      ],
    });
    const stackHome = await initialize(scan([initialSkill]));
    const currentSkill = skill(root, 'one', hash('a'), {
      locations: [
        {
          ...visible,
          isSymlink: true,
          realPath: path.join(root, 'targets', 'second'),
        },
      ],
    });
    const status = await statusMainEnvironment({
      stackHome,
      scanResult: scan([currentSkill]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      satisfied: 1,
      placementChanged: 1,
    });
  });

  it('status and diff are read-only and diff carries detailed entries', async () => {
    const root = path.join(await temp(), 'skills');
    const initial = scan([skill(root, 'one', hash('a'))]);
    const stackHome = await initialize(initial);
    const manifestPath = path.join(
      stackHome,
      'environments',
      'main',
      'environment.yaml',
    );
    const lockPath = path.join(
      stackHome,
      'environments',
      'main',
      'stack.lock.json',
    );
    const state = await loadMainEnvironment({ stackHome });
    const baselinePath = path.join(
      stackHome,
      'state',
      'machines',
      state.machine.machineId,
      'environments',
      'main.json',
    );
    const skillDirectory = path.join(root, 'one');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), 'unchanged');
    const before = await Promise.all(
      [manifestPath, lockPath, baselinePath].map((file) =>
        readFile(file, 'utf8'),
      ),
    );
    const skillBefore = await readFile(
      path.join(skillDirectory, 'SKILL.md'),
      'utf8',
    );
    await statusMainEnvironment({
      stackHome,
      scanResult: initial,
      now: fixedNow,
    });
    const diff = await diffMainEnvironment({
      stackHome,
      scanResult: initial,
      now: fixedNow,
    });
    const after = await Promise.all(
      [manifestPath, lockPath, baselinePath].map((file) =>
        readFile(file, 'utf8'),
      ),
    );
    expect(after).toEqual(before);
    expect(await readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8')).toBe(
      skillBefore,
    );
    expect(diff.entries[0]).toMatchObject({
      name: 'one',
      desiredHash: hash('a'),
      state: 'satisfied',
    });
  });
});

describe('Phase 3 preservation integration', () => {
  const createSkill = async (root: string, name = 'one') => {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'scripts'), { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\n---\n`,
    );
    await writeFile(path.join(directory, 'scripts', 'run.js'), 'run');
    return directory;
  };

  it('preserves one object for duplicate placements and records a snapshot', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const firstRoot = path.join(await temp(), 'codex');
    const secondRoot = path.join(await temp(), 'cursor');
    const first = await createSkill(firstRoot);
    const second = path.join(secondRoot, 'one');
    await cp(first, second, { recursive: true });
    const contentHash = (await hashSkillDirectory(first)).hash;
    const discovered = skill(firstRoot, 'one', contentHash, {
      locations: [
        location(firstRoot, 'one', 'codex'),
        location(secondRoot, 'one', 'cursor'),
      ],
    });

    const result = await realInitializeMainEnvironment({
      stackHome,
      scanResult: scan([discovered]),
      now: fixedNow,
      idFactory: fixedId,
    });
    const saved = await loadMainEnvironment({ stackHome });
    const locked = Object.values(saved.lock.skills)[0];

    expect(result).toMatchObject({
      preservedContents: 1,
      reusedContents: 0,
      references: 0,
      snapshots: 1,
      integrityChecks: 1,
    });
    expect(locked?.localContent).toEqual({ available: true, contentHash });
    expect(locked?.restoration).toMatchObject({
      strategy: 'snapshot',
      reason: 'local',
    });
    expect(Object.values(saved.baseline.skills)[0]?.locations).toHaveLength(2);
    expect(await verifyStoredSkill({ stackHome, contentHash })).toMatchObject({
      state: 'available',
    });
    const objects = await readdir(
      path.dirname(contentObjectPaths(stackHome, contentHash).objectDirectory),
    );
    expect(objects).toEqual([contentHash.slice('sha256:'.length)]);
    const snapshotId =
      locked?.restoration.strategy === 'snapshot'
        ? locked.restoration.snapshotId
        : '';
    expect(
      JSON.parse(
        await readFile(
          path.join(stackHome, 'snapshots', `${snapshotId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      contentHash,
      environmentEntryId: saved.manifest.skills[0]?.id,
    });
  });

  it('records one portable reference from duplicate Git and local evidence', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const gitRoot = path.join(await temp(), 'git-root');
    const localRoot = path.join(await temp(), 'local-root');
    const source = await createSkill(gitRoot);
    await cp(source, path.join(localRoot, 'one'), { recursive: true });
    const contentHash = (await hashSkillDirectory(source)).hash;
    const portableGit: SkillSource = {
      type: 'git',
      remote: 'git@github.com:example/skills.git',
      revision: 'abc123',
      path: 'skills/one',
      clean: true,
    };
    const discovered = skill(gitRoot, 'one', contentHash, {
      source: portableGit,
      locations: [
        location(gitRoot, 'one', 'codex', portableGit),
        location(localRoot, 'one', 'cursor', { type: 'local' }),
      ],
    });

    const result = await realInitializeMainEnvironment({
      stackHome,
      scanResult: scan([discovered]),
      now: fixedNow,
      idFactory: fixedId,
    });
    const locked = Object.values(
      (await loadMainEnvironment({ stackHome })).lock.skills,
    )[0];

    expect(result).toMatchObject({ references: 1, snapshots: 0 });
    expect(locked?.restoration).toEqual({
      strategy: 'reference',
      reference: {
        remote: 'git@github.com:example/skills.git',
        revision: 'abc123',
        path: 'skills/one',
        expectedContentHash: contentHash,
      },
    });
    expect(locked?.observedSources).toHaveLength(2);
    expect(JSON.stringify(locked)).not.toContain(stackHome);
    expect(
      await readdir(path.join(stackHome, 'snapshots')).catch(() => []),
    ).toEqual([]);
  });

  it('recovers exact content from Store after the source is deleted', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const root = path.join(await temp(), 'skills');
    const source = await createSkill(root);
    const contentHash = (await hashSkillDirectory(source)).hash;
    await realInitializeMainEnvironment({
      stackHome,
      scanResult: scan([skill(root, 'one', contentHash)]),
      now: fixedNow,
      idFactory: fixedId,
    });
    await rm(source, { recursive: true, force: true });

    const status = await realStatusMainEnvironment({
      stackHome,
      scanResult: scan([]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      missing: 1,
      preservation: { available: 1, missing: 0, corrupt: 0 },
    });
    const targetPath = path.join(await temp(), 'restored');
    await materializeStoredSkill({ stackHome, contentHash, targetPath });
    expect((await hashSkillDirectory(targetPath)).hash).toBe(contentHash);
  });

  it('preserves resolved content for a root-level Skill symlink occurrence', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const realRoot = path.join(await temp(), 'real');
    const realSkill = await createSkill(realRoot);
    const contentHash = (await hashSkillDirectory(realSkill)).hash;
    const visibleRoot = path.join(await temp(), 'visible');
    const visiblePath = path.join(visibleRoot, 'one');
    const discovered = skill(visibleRoot, 'one', contentHash, {
      locations: [
        {
          ...location(visibleRoot, 'one'),
          path: visiblePath,
          isSymlink: true,
          realPath: realSkill,
        },
      ],
    });

    await realInitializeMainEnvironment({
      stackHome,
      scanResult: scan([discovered]),
      now: fixedNow,
      idFactory: fixedId,
    });

    expect(await verifyStoredSkill({ stackHome, contentHash })).toMatchObject({
      state: 'available',
    });
  });

  it('keeps preserved content healthy after the source is modified', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const root = path.join(await temp(), 'skills');
    const source = await createSkill(root);
    const originalHash = (await hashSkillDirectory(source)).hash;
    await realInitializeMainEnvironment({
      stackHome,
      scanResult: scan([skill(root, 'one', originalHash)]),
      now: fixedNow,
      idFactory: fixedId,
    });
    await writeFile(path.join(source, 'scripts', 'run.js'), 'changed');
    const changedHash = (await hashSkillDirectory(source)).hash;
    const status = await realStatusMainEnvironment({
      stackHome,
      scanResult: scan([skill(root, 'one', changedHash)]),
      now: fixedNow,
    });
    expect(status.summary).toMatchObject({
      modified: 1,
      preservation: { available: 1 },
    });
    expect(
      await verifyStoredSkill({ stackHome, contentHash: originalHash }),
    ).toMatchObject({ state: 'available' });
  });

  it.each([
    [
      'missing',
      async (stackHome: string, contentHash: string) =>
        rm(contentObjectPaths(stackHome, contentHash).objectDirectory, {
          recursive: true,
          force: true,
        }),
    ],
    [
      'corrupt',
      async (stackHome: string, contentHash: string) =>
        writeFile(
          path.join(
            contentObjectPaths(stackHome, contentHash).contentPath,
            'SKILL.md',
          ),
          'corrupt',
        ),
    ],
  ] as const)(
    'reports %s preservation without changing logical satisfaction',
    async (expected, damage) => {
      idCounter = 0;
      const stackHome = await temp();
      const root = path.join(await temp(), 'skills');
      const source = await createSkill(root);
      const contentHash = (await hashSkillDirectory(source)).hash;
      const current = scan([skill(root, 'one', contentHash)]);
      await realInitializeMainEnvironment({
        stackHome,
        scanResult: current,
        now: fixedNow,
        idFactory: fixedId,
      });
      await damage(stackHome, contentHash);
      const before =
        expected === 'corrupt'
          ? await readFile(
              path.join(
                contentObjectPaths(stackHome, contentHash).contentPath,
                'SKILL.md',
              ),
              'utf8',
            )
          : undefined;

      const status = await realStatusMainEnvironment({
        stackHome,
        scanResult: current,
        now: fixedNow,
      });
      const diff = await realDiffMainEnvironment({
        stackHome,
        scanResult: current,
        now: fixedNow,
      });

      expect(status.summary.satisfied).toBe(1);
      expect(status.skills[0]?.preservation.state).toBe(expected);
      expect(diff.entries[0]?.preservation.state).toBe(expected);
      if (before)
        expect(
          await readFile(
            path.join(
              contentObjectPaths(stackHome, contentHash).contentPath,
              'SKILL.md',
            ),
            'utf8',
          ),
        ).toBe(before);
    },
  );

  it('does not commit main when preservation fails', async () => {
    idCounter = 0;
    const stackHome = await temp();
    const root = path.join(await temp(), 'skills');
    await createSkill(root);
    await expect(
      realInitializeMainEnvironment({
        stackHome,
        scanResult: scan([skill(root, 'one', hash('f'))]),
        now: fixedNow,
        idFactory: fixedId,
      }),
    ).rejects.toMatchObject({ code: 'content-hash-mismatch' });
    await expect(
      stat(path.join(stackHome, 'environments', 'main')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  ImportedStackVersion,
} from '@stack/spec';
import { loadLocalStack, StackCycleError } from './stack-loader.js';
import { importedVersionKey, resolveEnvironment } from './resolver.js';
import {
  applyStackRemove,
  applyStackUse,
  prepareStackRemove,
  prepareStackUse,
} from './composition.js';
import { loadMainEnvironment } from './state.js';

const dirs: string[] = [];
const temp = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'stack-composition-'));
  dirs.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});
const makeStack = async (
  root: string,
  name: string,
  body = 'body',
  requirement: 'required' | 'optional' = 'required',
) => {
  const directory = path.join(root, name);
  const skill = path.join(directory, 'skills', 'shared');
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    `---\nname: shared\ndescription: Shared skill\n---\n${body}\n`,
  );
  await writeFile(
    path.join(directory, 'stack.yaml'),
    `schemaVersion: 1\nname: ${name}\ndescription: ${name} Stack\nextends: []\nskills:\n  - path: ./skills/shared\n    requirement: ${requirement}\n`,
  );
  return directory;
};

describe('local Stack loading', () => {
  it('loads directories and direct manifests with deterministic portable versions', async () => {
    const root = await temp();
    const directory = await makeStack(root, 'frontend');
    const first = await loadLocalStack(directory);
    const second = await loadLocalStack(path.join(directory, 'stack.yaml'));
    expect(first.version).toEqual(second.version);
    expect(JSON.stringify(first.version)).not.toContain(
      path.resolve(directory),
    );
    await writeFile(
      path.join(directory, 'skills', 'shared', 'extra.txt'),
      'change',
    );
    expect((await loadLocalStack(directory)).version.versionHash).not.toBe(
      first.version.versionHash,
    );
  });

  it('resolves local extends and rejects cycles', async () => {
    const root = await temp();
    const base = await makeStack(root, 'base');
    const child = await makeStack(root, 'child', 'child');
    await writeFile(
      path.join(child, 'stack.yaml'),
      'schemaVersion: 1\nname: child\ndescription: Child\nextends:\n  - ../base\nskills: []\n',
    );
    expect((await loadLocalStack(child)).version.requirements).toHaveLength(1);
    await writeFile(
      path.join(base, 'stack.yaml'),
      'schemaVersion: 1\nname: base\ndescription: Base\nextends:\n  - ../child\nskills: []\n',
    );
    await expect(loadLocalStack(child)).rejects.toBeInstanceOf(StackCycleError);
  });

  it('emits a shared ancestor requirement once through diamond inheritance', async () => {
    const root = await temp();
    await makeStack(root, 'base');
    for (const name of ['left', 'right']) {
      const directory = path.join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'stack.yaml'),
        `schemaVersion: 1\nname: ${name}\ndescription: ${name}\nextends:\n  - ../base\nskills: []\n`,
      );
    }
    const top = path.join(root, 'top');
    await mkdir(top, { recursive: true });
    await writeFile(
      path.join(top, 'stack.yaml'),
      'schemaVersion: 1\nname: top\ndescription: top\nextends:\n  - ../left\n  - ../right\nskills: []\n',
    );
    expect((await loadLocalStack(top)).version.requirements).toHaveLength(1);
  });

  it('skips invalid optional Skills but rejects invalid required Skills', async () => {
    const root = await temp();
    const directory = await makeStack(root, 'optional');
    await writeFile(
      path.join(directory, 'stack.yaml'),
      'schemaVersion: 1\nname: optional\ndescription: Optional\nextends: []\nskills:\n  - path: ./missing\n    requirement: optional\n',
    );
    expect(
      (await loadLocalStack(directory)).version.skippedOptional,
    ).toHaveLength(1);
    await writeFile(
      path.join(directory, 'stack.yaml'),
      'schemaVersion: 1\nname: required\ndescription: Required\nextends: []\nskills:\n  - path: ./missing\n    requirement: required\n',
    );
    await expect(loadLocalStack(directory)).rejects.toMatchObject({
      code: 'stack-skill-not-found',
    });
  });
});

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const directLock = (contentHash: string): EnvironmentLock => ({
  schemaVersion: 1,
  resolvedAt: '2026-09-19T00:00:00.000Z',
  skills: {
    skill_direct01: {
      name: 'shared',
      description: 'direct',
      contentHash,
      metadata: { name: 'shared', description: 'direct' },
      observedSources: [{ type: 'local' }],
      localContent: { available: true, contentHash },
      restoration: {
        strategy: 'snapshot',
        snapshotId: 'snap_direct01',
        reason: 'local',
      },
    },
  },
});
const version = (
  name: string,
  contentHash: string,
  requirement: 'required' | 'optional',
): ImportedStackVersion => ({
  schemaVersion: 1,
  name,
  description: name,
  versionHash: hash(name.charAt(0)),
  requirements: [
    {
      id: `req_${name.padEnd(8, 'x')}`,
      name: 'shared',
      requirement,
      contentHash,
      metadata: { name: 'shared', description: name },
      restoration: {
        strategy: 'snapshot',
        snapshotId: `snap_${name.padEnd(8, 'x')}`,
        reason: 'local',
      },
      observedSources: [{ type: 'local' }],
      originStackName: name,
    },
  ],
  inheritedStacks: [],
  skippedOptional: [],
});
describe('Environment resolver', () => {
  it('deduplicates exact requirements while retaining origins and the direct ID', () => {
    const layer = {
      id: 'layer_frontend',
      stackId: 'stack_frontend',
      name: 'frontend',
      versionHash: hash('f'),
    };
    const manifest: EnvironmentManifest = {
      schemaVersion: 1,
      name: 'main',
      skills: [
        { id: 'skill_direct01', name: 'shared', requirement: 'required' },
      ],
      stacks: [layer],
      overrides: {},
    };
    const versions = new Map([
      [importedVersionKey(layer), version('frontend', hash('a'), 'required')],
    ]);
    const result = resolveEnvironment({
      manifest,
      lock: directLock(hash('a')),
      versions,
      idFactory: () => 'newentry1',
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.entryId).toBe('skill_direct01');
    expect(result.skills[0]?.origins).toHaveLength(2);
  });

  it('reports required conflicts and deterministically skips optional conflicts', () => {
    const layers = ['first', 'second'].map((name) => ({
      id: `layer_${name}xx`,
      stackId: `stack_${name}xx`,
      name,
      versionHash: hash(name.charAt(0)),
    }));
    const manifest: EnvironmentManifest = {
      schemaVersion: 1,
      name: 'main',
      skills: [],
      stacks: layers,
      overrides: {},
    };
    const required = new Map(
      layers.map((layer, index) => [
        importedVersionKey(layer),
        version(layer.name, hash(index ? 'b' : 'a'), 'required'),
      ]),
    );
    expect(
      resolveEnvironment({
        manifest,
        lock: {
          schemaVersion: 1,
          resolvedAt: '2026-09-19T00:00:00.000Z',
          skills: {},
        },
        versions: required,
        idFactory: () => 'generated1',
      }).conflicts,
    ).toHaveLength(1);
    const optional = new Map(
      layers.map((layer, index) => [
        importedVersionKey(layer),
        version(layer.name, hash(index ? 'b' : 'a'), 'optional'),
      ]),
    );
    const result = resolveEnvironment({
      manifest,
      lock: {
        schemaVersion: 1,
        resolvedAt: '2026-09-19T00:00:00.000Z',
        skills: {},
      },
      versions: optional,
      idFactory: () => 'generated1',
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.skills[0]?.contentHash).toBe(hash('a'));
    expect(result.skipped[0]?.reason).toBe('optional-conflict');
  });
});

const machineId = '00000000-0000-4000-8000-000000000000';
const seedMain = async (stackHome: string) => {
  const environment = path.join(stackHome, 'environments', 'main');
  const state = path.join(
    stackHome,
    'state',
    'machines',
    machineId,
    'environments',
  );
  await mkdir(environment, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    path.join(stackHome, 'machine.json'),
    JSON.stringify({
      schemaVersion: 1,
      machineId,
      createdAt: '2026-09-19T00:00:00.000Z',
      platform: 'win32',
      arch: 'x64',
    }),
  );
  await writeFile(
    path.join(environment, 'environment.yaml'),
    'schemaVersion: 1\nname: main\nskills: []\nstacks: []\noverrides: {}\n',
  );
  await writeFile(
    path.join(environment, 'stack.lock.json'),
    JSON.stringify({
      schemaVersion: 1,
      resolvedAt: '2026-09-19T00:00:00.000Z',
      skills: {},
    }),
  );
  await writeFile(
    path.join(state, 'main.json'),
    JSON.stringify({
      schemaVersion: 1,
      machineId,
      environment: 'main',
      capturedAt: '2026-09-19T00:00:00.000Z',
      skills: {},
    }),
  );
};

describe('Stack composition persistence', () => {
  it('imports preserved content, survives source deletion, and removes only desired state', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'state');
    await seedMain(stackHome);
    const bundle = await makeStack(root, 'portable');
    const proposal = await prepareStackUse({
      stackHome,
      input: bundle,
      idFactory: (() => {
        const ids = ['stackid1', 'layerid1', 'entryid1'];
        return () => ids.shift() ?? 'fallback1';
      })(),
    });
    expect(proposal.summary.newSkills).toBe(1);
    await applyStackUse(proposal, {
      now: () => new Date('2026-09-19T01:00:00.000Z'),
    });
    const importedPath = path.join(
      stackHome,
      'stacks',
      proposal.layer.stackId,
      'versions',
      proposal.layer.versionHash.slice(7),
      'stack.lock.json',
    );
    expect(JSON.parse(await readFile(importedPath, 'utf8')).name).toBe(
      'portable',
    );
    const loaded = await loadMainEnvironment({ stackHome });
    expect(loaded.manifest.stacks).toHaveLength(1);
    expect(Object.values(loaded.lock.skills)).toHaveLength(1);
    expect(JSON.stringify(loaded.manifest)).not.toContain(bundle);
    expect(JSON.stringify(loaded.lock)).not.toContain(bundle);
    await rm(bundle, { recursive: true, force: true });
    const removal = await prepareStackRemove({
      stackHome,
      identifier: 'portable',
      idFactory: () => 'unusedid1',
    });
    await applyStackRemove(removal, {
      now: () => new Date('2026-09-19T02:00:00.000Z'),
    });
    expect((await loadMainEnvironment({ stackHome })).manifest.stacks).toEqual(
      [],
    );
    expect(await stat(importedPath)).toBeTruthy();
  });

  it('performs no persistent mutation during preparation and rejects duplicate activation', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'state');
    await seedMain(stackHome);
    const bundle = await makeStack(root, 'preview');
    const proposal = await prepareStackUse({
      stackHome,
      input: bundle,
      idFactory: (() => {
        const ids = ['stackid1', 'layerid1', 'entryid1'];
        return () => ids.shift() ?? 'fallback1';
      })(),
    });
    expect((await loadMainEnvironment({ stackHome })).manifest.stacks).toEqual(
      [],
    );
    await applyStackUse(proposal);
    await expect(
      prepareStackUse({ stackHome, input: bundle }),
    ).rejects.toMatchObject({ code: 'stack-already-active' });
  });

  it('rejects a stale proposal instead of overwriting a newer Environment', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'state');
    await seedMain(stackHome);
    const firstBundle = await makeStack(root, 'first');
    const secondBundle = await makeStack(root, 'second', 'different');
    const first = await prepareStackUse({ stackHome, input: firstBundle });
    const stale = await prepareStackUse({ stackHome, input: secondBundle });
    await applyStackUse(first);
    await expect(applyStackUse(stale)).rejects.toMatchObject({
      code: 'environment-changed',
    });
    expect(
      (await loadMainEnvironment({ stackHome })).manifest.stacks.map(
        (item) => item.name,
      ),
    ).toEqual(['first']);
  });
});

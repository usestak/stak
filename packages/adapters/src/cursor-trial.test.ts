import {
  access,
  mkdir as filesystemMkdir,
  readFile,
  writeFile as filesystemWriteFile,
} from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createOwnedTestRoot,
  hashSkillDirectory,
  type OwnedTestRoot,
  pathIsWithin,
} from '@stack/shared';
import type { TryResolvedEnvironment } from '@stack/spec';
import { ingestSkill } from '@stack/store';

import {
  bridgeCursorRuntimeState,
  cleanupCursorTryRuntime,
  launchCursorTryRuntime,
  prepareCursorTryRuntime,
  recoverStaleCursorTryRuntimes,
} from './cursor-trial.js';

const ownedRoots: OwnedTestRoot[] = [];
const temp = async () => {
  const owned = await createOwnedTestRoot('stack-cursor-try-');
  ownedRoots.push(owned);
  return owned.rootPath;
};
const assertOwnedMutation = async (target: string) => {
  for (const owned of ownedRoots)
    if (await pathIsWithin({ ownedRoot: owned.rootPath, proposedPath: target }))
      return owned.assertMutationPath(target);
  throw new Error('Test fixture target is outside every owned root.');
};
const mkdir = async (target: string, options?: { recursive?: boolean }) => {
  await assertOwnedMutation(target);
  await filesystemMkdir(target, options);
};
const writeFile = async (target: string, contents: string) => {
  await assertOwnedMutation(target);
  await filesystemWriteFile(target, contents);
};
afterEach(async () => {
  await Promise.all(ownedRoots.splice(0).map((owned) => owned.cleanup()));
});

const storedTrial = async (
  stackHome: string,
  names = ['trial-skill'],
): Promise<TryResolvedEnvironment> => {
  const skills: TryResolvedEnvironment['environment']['skills'] = [];
  for (const [index, name] of names.entries()) {
    const source = path.join(await temp(), name);
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\ntrial ${index}\n`,
    );
    const contentHash = (await hashSkillDirectory(source)).hash;
    await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash: contentHash,
    });
    skills.push({
      entryId: `skill_trial_${String(index).padStart(8, '0')}`,
      name,
      contentHash,
      metadata: { name, description: name },
      restoration: {
        strategy: 'snapshot',
        snapshotId: `snap_trial_${String(index).padStart(8, '0')}`,
        reason: 'local',
      },
      observedSources: [{ type: 'local' }],
      origins: [
        {
          type: 'stack',
          layerId: 'layer_12345678',
          stackId: 'stack_12345678',
          stackName: 'trial',
          requirementId: `req_trial_${String(index).padStart(8, '0')}`,
          requirement: 'required',
        },
      ],
    });
  }
  return {
    stackName: 'trial',
    stackVersionHash: `sha256:${'a'.repeat(64)}`,
    environment: { name: 'try:trial', skills, skipped: [], conflicts: [] },
    skippedOptional: 0,
    required: skills.length,
    optionalIncluded: 0,
    isolation: {
      temporaryHome: true,
      temporaryAgentHome: true,
      scratchWorkspace: true,
      normalBindingsUntouched: true,
      mainUntouched: true,
    },
  };
};

describe('Cursor trial runtime', () => {
  it('bridges only cli-config.json verbatim', async () => {
    const root = await temp();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, 'cli-config.json'),
      '{"editor":"vim"}',
    );
    await writeFile(path.join(source, 'auth-session.bin'), 'undocumented');
    expect(
      await bridgeCursorRuntimeState({
        sourceCursorHome: source,
        runtimeCursorHome: target,
      }),
    ).toEqual(['cli-config.json']);
    expect(
      await readFile(path.join(target, 'cli-config.json'), 'utf8'),
    ).toBe('{"editor":"vim"}');
    await expect(
      access(path.join(target, 'auth-session.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes Skills into .agents/skills (shared with Codex by design)', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => 'cursor001',
    });
    expect(preparation.session.resolvedSkills.at(0)?.targetPath).toContain(
      path.join('.agents', 'skills'),
    );
    await cleanupCursorTryRuntime({ stackHome, session: preparation.session });
  });

  it('prepare/dry-run succeeds with no CURSOR_API_KEY/CURSOR_AUTH_TOKEN set', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => 'cursor002',
    });
    expect(preparation.session.status).toBe('ready');
    await cleanupCursorTryRuntime({ stackHome, session: preparation.session });
  });

  it('refuses to launch when neither CURSOR_API_KEY nor CURSOR_AUTH_TOKEN is set, and still cleans up', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'cursor003',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    let spawned = false;
    await expect(
      launchCursorTryRuntime({
        stackHome,
        preparation,
        detection: { agent: 'cursor', installed: true, executablePath: '/fake' },
        env: {},
        spawnProcess: async () => {
          spawned = true;
          return { exitCode: 0, signal: null };
        },
      }),
    ).rejects.toMatchObject({ code: 'cursor-try-auth-required' });
    expect(spawned).toBe(false);
    await expect(access(sessionRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('launches with CURSOR_CONFIG_DIR isolated and forwards CURSOR_API_KEY', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'cursor004',
    });
    let observed: unknown;
    const result = await launchCursorTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'cursor', installed: true, executablePath: '/fake' },
      env: { CURSOR_API_KEY: 'sk-test-123' },
      spawnProcess: async (_file, _args, options) => {
        observed = options;
        return { exitCode: 0, signal: null };
      },
    });
    expect(observed).toMatchObject({
      env: {
        CURSOR_CONFIG_DIR: preparation.session.runtimeAgentHomePath,
        CURSOR_API_KEY: 'sk-test-123',
      },
    });
    expect(result).toMatchObject({ exitCode: 0, cleaned: true });
  });

  it('forwards CURSOR_AUTH_TOKEN when only that is set', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'cursor005',
    });
    let observed: unknown;
    await launchCursorTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'cursor', installed: true, executablePath: '/fake' },
      env: { CURSOR_AUTH_TOKEN: 'tok-abc' },
      spawnProcess: async (_file, _args, options) => {
        observed = options;
        return { exitCode: 0, signal: null };
      },
    });
    expect(observed).toMatchObject({
      env: { CURSOR_AUTH_TOKEN: 'tok-abc' },
    });
  });

  it('cleans up after a launch failure', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'cursor006',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    await expect(
      launchCursorTryRuntime({
        stackHome,
        preparation,
        detection: { agent: 'cursor', installed: true, executablePath: '/fake' },
        env: { CURSOR_API_KEY: 'sk-test' },
        spawnProcess: async () => {
          throw new Error('launch failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'agent-launch-failed' });
    await expect(access(sessionRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not touch a ready (non-cleanup-failed) Cursor runtime on recovery', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'cursor007',
    });
    const result = await recoverStaleCursorTryRuntimes({ stackHome });
    expect(result.scanned).toBe(0);
    await cleanupCursorTryRuntime({ stackHome, session: preparation.session });
  });
});

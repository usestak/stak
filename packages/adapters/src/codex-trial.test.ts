import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { TryResolvedEnvironment } from '@stack/spec';
import { ingestSkill } from '@stack/store';

import {
  bridgeCodexRuntimeState,
  cleanupCodexTryRuntime,
  launchCodexTryRuntime,
  prepareCodexTryRuntime,
} from './codex-trial.js';

const directories: string[] = [];
const temp = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'stack-codex-try-'));
  directories.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});
const storedTrial = async (stackHome: string, names = ['trial-skill']) => {
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
      temporaryCodexHome: true,
      scratchWorkspace: true,
      normalBindingsUntouched: true,
      mainUntouched: true,
    },
  } satisfies TryResolvedEnvironment;
};

describe('Codex trial runtime', () => {
  it('bridges only allowlisted root configuration files', async () => {
    const root = await temp();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(path.join(source, 'skills'), { recursive: true });
    await mkdir(path.join(source, 'sessions'), { recursive: true });
    await writeFile(path.join(source, 'config.toml'), 'config');
    await writeFile(path.join(source, 'work.config.toml'), 'profile');
    await writeFile(path.join(source, 'auth.json'), 'sentinel-secret');
    await writeFile(path.join(source, 'history.jsonl'), 'history');
    await writeFile(path.join(source, 'skills', 'bad'), 'skill');
    expect(
      await bridgeCodexRuntimeState({
        sourceCodexHome: source,
        runtimeCodexHome: target,
      }),
    ).toEqual(['auth.json', 'config.toml', 'work.config.toml']);
    expect(await readFile(path.join(target, 'auth.json'), 'utf8')).toBe(
      'sentinel-secret',
    );
    await expect(
      access(path.join(target, 'history.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(target, 'skills'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('materializes real workspace Skills with isolated homes and leaves normal roots untouched', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real-home');
    const realSkill = path.join(realHome, '.agents', 'skills', 'normal');
    await mkdir(realSkill, { recursive: true });
    await writeFile(path.join(realSkill, 'SKILL.md'), 'normal');
    const normalBefore = await readFile(
      path.join(realSkill, 'SKILL.md'),
      'utf8',
    );
    const trial = await storedTrial(stackHome);
    const result = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      env: {},
      idFactory: () => '12345678',
    });
    expect(result.session.runtimeHomePath).not.toBe(realHome);
    expect(result.session.runtimeCodexHomePath).not.toBe(
      path.join(realHome, '.codex'),
    );
    const materialized = result.session.resolvedSkills.at(0);
    const expected = trial.environment.skills.at(0);
    expect(materialized).toBeDefined();
    expect(expected).toBeDefined();
    if (!materialized || !expected)
      throw new Error('Expected one trial Skill.');
    expect((await hashSkillDirectory(materialized.targetPath)).hash).toBe(
      expected.contentHash,
    );
    expect(
      (
        await (
          await import('node:fs/promises')
        ).lstat(path.join(result.session.workspacePath, '.agents', 'skills'))
      ).isSymbolicLink(),
    ).toBe(false);
    expect(await readFile(path.join(realSkill, 'SKILL.md'), 'utf8')).toBe(
      normalBefore,
    );
    await rm(path.dirname(result.session.workspacePath), {
      recursive: true,
      force: true,
    });
  });

  it('launches with isolated path metadata and cleans after zero or non-zero exits', async () => {
    for (const exitCode of [0, 7]) {
      const root = await temp();
      const stackHome = path.join(root, 'stack');
      const trial = await storedTrial(stackHome);
      const preparation = await prepareCodexTryRuntime({
        stackHome,
        trial,
        homeDir: path.join(root, 'real'),
        env: { TOKEN: 'kept' },
        idFactory: () => `session${exitCode}x`,
      });
      const sessionRoot = path.dirname(preparation.session.workspacePath);
      let observed: unknown;
      const result = await launchCodexTryRuntime({
        stackHome,
        preparation,
        detection: {
          agent: 'codex',
          installed: true,
          executablePath: '/fake/codex',
        },
        env: {
          HOME: '/real',
          USERPROFILE: '/real',
          CODEX_HOME: '/real/.codex',
          TOKEN: 'kept',
        },
        spawnProcess: async (_file, _args, options) => {
          observed = options;
          expect(
            await readFile(
              path.join(
                options.cwd,
                '.agents',
                'skills',
                'trial-skill',
                'SKILL.md',
              ),
              'utf8',
            ),
          ).toContain('trial');
          return { exitCode, signal: null };
        },
      });
      expect(observed).toMatchObject({
        cwd: preparation.session.workspacePath,
        env: {
          HOME: preparation.session.runtimeHomePath,
          USERPROFILE: preparation.session.runtimeHomePath,
          CODEX_HOME: preparation.session.runtimeCodexHomePath,
          TOKEN: 'kept',
        },
        shell: false,
        stdio: 'inherit',
      });
      expect(result).toMatchObject({ exitCode, cleaned: true });
      await expect(access(sessionRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('cleans runtime after launch or materialization failure without exposing auth contents', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real');
    await mkdir(path.join(realHome, '.codex'), { recursive: true });
    await writeFile(
      path.join(realHome, '.codex', 'auth.json'),
      'sentinel-secret',
    );
    const trial = await storedTrial(stackHome);
    await expect(
      prepareCodexTryRuntime({
        stackHome,
        trial,
        homeDir: realHome,
        idFactory: () => 'failed001',
        materialize: async () => {
          throw new Error('copy failed');
        },
      }),
    ).rejects.not.toThrow(/sentinel-secret/);
    expect(
      await (
        await import('node:fs/promises')
      ).readdir(path.join(stackHome, 'runtime')),
    ).toEqual([]);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      idFactory: () => 'failed002',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    await expect(
      launchCodexTryRuntime({
        stackHome,
        preparation,
        detection: { agent: 'codex', installed: true, executablePath: '/fake' },
        spawnProcess: async () => {
          throw new Error('launch failed');
        },
      }),
    ).rejects.not.toThrow(/sentinel-secret/);
    await expect(access(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves main state and the normal Codex binding registry byte-for-byte unchanged', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real');
    const protectedFiles = [
      path.join(stackHome, 'environments', 'main', 'environment.yaml'),
      path.join(stackHome, 'environments', 'main', 'stack.lock.json'),
      path.join(
        stackHome,
        'state',
        'machines',
        'machine',
        'environments',
        'main.json',
      ),
      path.join(
        stackHome,
        'state',
        'machines',
        'machine',
        'bindings',
        'codex.json',
      ),
    ];
    for (const [index, file] of protectedFiles.entries()) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `protected-${index}`);
    }
    const before = await Promise.all(
      protectedFiles.map((file) => readFile(file)),
    );
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      idFactory: () => 'invariant1',
    });
    await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: '/fake' },
      spawnProcess: async () => ({ exitCode: 0, signal: null }),
    });
    const after = await Promise.all(
      protectedFiles.map((file) => readFile(file)),
    );
    expect(after).toEqual(before);
  });

  it('does not delete a caller-supplied directory outside the owned runtime root', async () => {
    const root = await temp();
    const outside = path.join(root, 'outside', 'try_malicious1');
    await mkdir(path.join(outside, 'workspace'), { recursive: true });
    const session = {
      schemaVersion: 1 as const,
      sessionId: 'try_malicious1',
      agent: 'codex' as const,
      createdAt: '2026-09-19T12:00:00.000Z',
      ownerPid: 1,
      source: { type: 'local-stack' as const, displayName: 'trial' },
      runtimeRootPath: path.join(root, 'outside'),
      workspacePath: path.join(outside, 'workspace'),
      runtimeHomePath: path.join(outside, 'home'),
      runtimeCodexHomePath: path.join(outside, 'codex-home'),
      resolvedSkills: [],
      status: 'ready' as const,
    };
    await writeFile(
      path.join(outside, 'session.json'),
      JSON.stringify(session),
    );
    await expect(
      cleanupCodexTryRuntime({
        stackHome: path.join(root, 'stack'),
        session,
      }),
    ).rejects.toMatchObject({ code: 'try-runtime-cleanup-failed' });
    await expect(access(outside)).resolves.toBeUndefined();
  });

  it('preserves pre-existing runtime paths when session identifiers collide', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const runtimeRoot = path.join(stackHome, 'runtime');
    const collision = path.join(runtimeRoot, 'try_collision1');
    await mkdir(collision, { recursive: true });
    const trial = await storedTrial(stackHome);

    await expect(
      prepareCodexTryRuntime({
        stackHome,
        trial,
        idFactory: () => 'collision1',
      }),
    ).rejects.toMatchObject({ code: 'try-runtime-preparation-failed' });
    expect(await (await import('node:fs/promises')).readdir(collision)).toEqual(
      [],
    );
  });

  it('does not report cleanup success when an existing runtime lost its marker', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      idFactory: () => 'missingmarker1',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    await rm(path.join(sessionRoot, 'session.json'));

    await expect(
      cleanupCodexTryRuntime({
        stackHome,
        session: preparation.session,
      }),
    ).rejects.toMatchObject({ code: 'try-runtime-cleanup-failed' });
    await expect(access(sessionRoot)).resolves.toBeUndefined();
  });
});

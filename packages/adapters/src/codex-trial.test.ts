import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir as filesystemMkdir,
  readFile,
  readdir,
  rm,
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
import type { TryResolvedEnvironment, TrySession } from '@stack/spec';
import { ingestSkill } from '@stack/store';

import {
  bridgeCodexRuntimeState,
  cleanupCodexTryRuntime,
  launchCodexTryRuntime,
  prepareCodexTryRuntime,
  recoverStaleTryRuntimes,
  sanitizeCodexConfigToml,
} from './codex-trial.js';

const ownedRoots: OwnedTestRoot[] = [];
const temp = async () => {
  const owned = await createOwnedTestRoot('stack-codex-try-');
  ownedRoots.push(owned);
  return owned.rootPath;
};
const removeOwned = async (target: string) => {
  for (const owned of ownedRoots)
    if (
      await pathIsWithin({
        ownedRoot: owned.rootPath,
        proposedPath: target,
      })
    ) {
      await owned.cleanupPath(target);
      return;
    }
  throw new Error('Test cleanup target is outside every owned root.');
};
const assertOwnedMutation = async (target: string) => {
  for (const owned of ownedRoots)
    if (
      await pathIsWithin({
        ownedRoot: owned.rootPath,
        proposedPath: target,
      })
    )
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
    await cleanupCodexTryRuntime({
      stackHome,
      session: result.session,
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
    await removeOwned(path.join(sessionRoot, 'session.json'));

    await expect(
      cleanupCodexTryRuntime({
        stackHome,
        session: preparation.session,
      }),
    ).rejects.toMatchObject({ code: 'try-runtime-cleanup-failed' });
    await expect(access(sessionRoot)).resolves.toBeUndefined();
  });

  it('aborts before writes when runtime HOME equals the real HOME', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const protectedFiles = [
      path.join(stackHome, 'environments', 'main', 'environment.yaml'),
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
    const protectedBefore = await Promise.all(
      protectedFiles.map((file) => readFile(file)),
    );
    const sessionId = 'try_equalhome1';
    const runtimeHome = path.join(stackHome, 'runtime', sessionId, 'home');
    const trial = await storedTrial(stackHome);

    await expect(
      prepareCodexTryRuntime({
        stackHome,
        trial,
        homeDir: runtimeHome,
        idFactory: () => 'equalhome1',
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    await expect(access(path.join(stackHome, 'runtime'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(
      await Promise.all(protectedFiles.map((file) => readFile(file))),
    ).toEqual(protectedBefore);
  });

  it('aborts before writes when runtime CODEX_HOME equals the real CODEX_HOME', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const sessionId = 'try_equalcodex1';
    const runtimeCodexHome = path.join(
      stackHome,
      'runtime',
      sessionId,
      'codex-home',
    );
    const trial = await storedTrial(stackHome);

    await expect(
      prepareCodexTryRuntime({
        stackHome,
        trial,
        homeDir: path.join(root, 'real-home'),
        env: { CODEX_HOME: runtimeCodexHome },
        idFactory: () => 'equalcodex1',
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    await expect(access(path.join(stackHome, 'runtime'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('aborts before writes when the trial Skill root is the real user Skill root', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const sessionId = 'try_equalskills1';
    const workspace = path.join(stackHome, 'runtime', sessionId, 'workspace');
    const trial = await storedTrial(stackHome);

    await expect(
      prepareCodexTryRuntime({
        stackHome,
        trial,
        homeDir: workspace,
        env: {},
        idFactory: () => 'equalskills1',
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    await expect(access(path.join(stackHome, 'runtime'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('preserves a canary real-home Skill tree byte-for-byte through prepare, launch, and cleanup', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack-home');
    const realHome = path.join(root, 'real-home');
    const userSentinel = path.join(
      realHome,
      '.agents',
      'skills',
      'do-not-touch',
      'SKILL.md',
    );
    const legacySentinel = path.join(
      realHome,
      '.codex',
      'skills',
      'do-not-touch',
      'SKILL.md',
    );
    await mkdir(path.dirname(userSentinel), { recursive: true });
    await mkdir(path.dirname(legacySentinel), { recursive: true });
    await writeFile(userSentinel, 'user-sentinel-bytes');
    await writeFile(legacySentinel, 'legacy-sentinel-bytes');
    const before = await hashSkillDirectory(realHome);
    const trial = await storedTrial(stackHome, ['trial-only']);

    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      env: {},
      idFactory: () => 'canaryhome1',
    });
    await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: '/fake' },
      spawnProcess: async (_file, _args, options) => {
        await expect(
          access(
            path.join(
              options.cwd,
              '.agents',
              'skills',
              'trial-only',
              'SKILL.md',
            ),
          ),
        ).resolves.toBeUndefined();
        return { exitCode: 0, signal: null };
      },
    });

    expect(await hashSkillDirectory(realHome)).toEqual(before);
    expect(await readFile(userSentinel, 'utf8')).toBe('user-sentinel-bytes');
    expect(await readFile(legacySentinel, 'utf8')).toBe(
      'legacy-sentinel-bytes',
    );
  });

  it('rechecks real-home separation immediately before launch', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack-home');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real-home'),
      env: {},
      idFactory: () => 'launchfence1',
    });
    let spawned = false;

    await expect(
      launchCodexTryRuntime({
        stackHome,
        preparation,
        detection: {
          agent: 'codex',
          installed: true,
          executablePath: '/fake',
        },
        env: { HOME: preparation.session.runtimeHomePath },
        spawnProcess: async () => {
          spawned = true;
          return { exitCode: 0, signal: null };
        },
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    expect(spawned).toBe(false);
    await expect(
      access(path.dirname(preparation.session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write a failure marker through tampered outside-runtime metadata', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack-home');
    const outside = path.join(root, 'outside-runtime');
    await mkdir(path.join(outside, 'workspace'), { recursive: true });
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real-home'),
      env: {},
      idFactory: () => 'tamperedlaunch1',
    });
    const tampered = {
      ...preparation,
      session: {
        ...preparation.session,
        workspacePath: path.join(outside, 'workspace'),
        runtimeHomePath: path.join(outside, 'home'),
        runtimeCodexHomePath: path.join(outside, 'codex-home'),
      },
    };

    await expect(
      launchCodexTryRuntime({
        stackHome,
        preparation: tampered,
        detection: {
          agent: 'codex',
          installed: true,
          executablePath: '/fake',
        },
        spawnProcess: async () => ({ exitCode: 0, signal: null }),
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    await expect(
      access(path.join(outside, 'session.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot overwrite or delete a different owned runtime session', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack-home');
    const trial = await storedTrial(stackHome);
    const first = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real-home'),
      env: {},
      idFactory: () => 'sessionowner1',
    });
    const second = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real-home'),
      env: {},
      idFactory: () => 'sessionowner2',
    });
    const secondMarker = path.join(
      path.dirname(second.session.workspacePath),
      'session.json',
    );
    const markerBefore = await readFile(secondMarker);
    const forged = {
      ...first,
      session: {
        ...first.session,
        workspacePath: second.session.workspacePath,
        runtimeHomePath: second.session.runtimeHomePath,
        runtimeCodexHomePath: second.session.runtimeCodexHomePath,
      },
    };

    await expect(
      launchCodexTryRuntime({
        stackHome,
        preparation: forged,
        detection: {
          agent: 'codex',
          installed: true,
          executablePath: '/fake',
        },
        spawnProcess: async () => ({ exitCode: 0, signal: null }),
      }),
    ).rejects.toMatchObject({ code: 'unsafe-runtime-path' });
    expect(await readFile(secondMarker)).toEqual(markerBefore);
    await expect(
      access(path.dirname(first.session.workspacePath)),
    ).resolves.toBeUndefined();
    await expect(
      access(path.dirname(second.session.workspacePath)),
    ).resolves.toBeUndefined();
    await cleanupCodexTryRuntime({ stackHome, session: first.session });
    await cleanupCodexTryRuntime({ stackHome, session: second.session });
  });
});

const onWindows = process.platform === 'win32';
const fsError = (code: string) =>
  Object.assign(new Error(`simulated ${code}`), { code });
// A remover that records call order/attempts and can simulate failures before
// delegating to a real recursive delete.
const recordingRemover = (
  behavior?: (target: string, attempt: number) => void,
) => {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const remove = async (target: string) => {
    calls.push(target);
    const attempt = (attempts.get(target) ?? 0) + 1;
    attempts.set(target, attempt);
    behavior?.(target, attempt);
    await rm(target, { recursive: true, force: true });
  };
  return {
    remove,
    calls,
    attemptsFor: (target: string) => attempts.get(target) ?? 0,
  };
};
const fastControls = { retryDelayMs: 0, sleep: async () => undefined };
// A real npm-style Codex shim (a .cmd on Windows, a shebang script on Unix)
// that writes a marker into its cwd and exits 0.
const makeCodexShim = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'codex-impl.js'),
    `require('fs').writeFileSync(require('path').join(process.cwd(),'ran.txt'),'ok');process.exit(0);\n`,
  );
  if (onWindows) {
    const shim = path.join(directory, 'codex.cmd');
    await writeFile(shim, '@echo off\r\nnode "%~dp0codex-impl.js" %*\r\n');
    return shim;
  }
  const shim = path.join(directory, 'codex');
  await writeFile(
    shim,
    `#!/bin/sh\nexec node "$(dirname "$0")/codex-impl.js" "$@"\n`,
  );
  await chmod(shim, 0o755);
  return shim;
};

describe('Codex trial runtime cleanup hardening', () => {
  const prepared = async (root: string, id: string) => {
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => id,
    });
    return { stackHome, session: preparation.session, preparation };
  };

  it('keeps the ownership marker present while the workspace is removed', async () => {
    const { stackHome, session } = await prepared(await temp(), 'markerlive1');
    const sessionRoot = path.dirname(session.workspacePath);
    let markerPresent = false;
    await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      removeEntry: async (target) => {
        if (target === session.workspacePath)
          markerPresent = await access(path.join(sessionRoot, 'session.json'))
            .then(() => true)
            .catch(() => false);
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(markerPresent).toBe(true);
  });

  it('removes workspace, home, codex-home, then the marker last, then the root', async () => {
    const { stackHome, session } = await prepared(await temp(), 'orderly1');
    const { remove, calls } = recordingRemover();
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      removeEntry: remove,
    });
    const label = (target: string) =>
      target === session.workspacePath
        ? 'workspace'
        : target === session.runtimeHomePath
          ? 'home'
          : target === session.runtimeCodexHomePath
            ? 'codex-home'
            : path.basename(target);
    expect(outcome.cleaned).toBe(true);
    expect(calls.map(label)).toEqual([
      'workspace',
      'home',
      'codex-home',
      'session.json',
    ]);
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a permanent workspace failure preserves a cleanup-failed marker with a safe, secret-free diagnostic', async () => {
    const { stackHome, session } = await prepared(await temp(), 'permfail1');
    // A secret living in the runtime must never appear in the retained marker.
    await writeFile(
      path.join(session.runtimeCodexHomePath!, 'auth.json'),
      'sentinel-secret',
    );
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      maxRetries: 2,
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      removeEntry: async (target) => {
        if (target === session.workspacePath) throw fsError('EPERM');
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(outcome).toMatchObject({ cleaned: false });
    const sessionRoot = path.dirname(session.workspacePath);
    const raw = await readFile(path.join(sessionRoot, 'session.json'), 'utf8');
    expect(raw).not.toContain('sentinel-secret');
    const marker = JSON.parse(raw);
    expect(marker.status).toBe('cleanup-failed');
    expect(marker.cleanup).toEqual({
      component: 'workspace',
      code: 'EPERM',
      at: '2026-09-20T00:00:00.000Z',
    });
    expect(Object.keys(marker.cleanup).sort()).toEqual([
      'at',
      'code',
      'component',
    ]);
  });

  it('retries a transient EPERM and eventually completes cleanup', async () => {
    const { stackHome, session } = await prepared(await temp(), 'transient1');
    const { remove, attemptsFor } = recordingRemover((target, attempt) => {
      if (target === session.workspacePath && attempt === 1)
        throw fsError('EPERM');
    });
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      maxRetries: 3,
      removeEntry: remove,
    });
    expect(outcome.cleaned).toBe(true);
    expect(attemptsFor(session.workspacePath)).toBe(2);
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops after the retry budget and retains the marked runtime', async () => {
    const { stackHome, session } = await prepared(await temp(), 'exhausted1');
    const { remove, attemptsFor } = recordingRemover((target) => {
      if (target === session.workspacePath) throw fsError('EPERM');
    });
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      maxRetries: 3,
      removeEntry: remove,
    });
    expect(outcome.cleaned).toBe(false);
    expect(attemptsFor(session.workspacePath)).toBe(3);
    await expect(
      access(path.join(path.dirname(session.workspacePath), 'session.json')),
    ).resolves.toBeUndefined();
  });

  it.each(['ENOTEMPTY', 'EBUSY'])(
    'retries a transient %s deletion error',
    async (code) => {
      const { stackHome, session } = await prepared(
        await temp(),
        `transient${code.toLowerCase()}1`,
      );
      const { remove } = recordingRemover((target, attempt) => {
        if (target === session.workspacePath && attempt === 1)
          throw fsError(code);
      });
      const outcome = await cleanupCodexTryRuntime({
        stackHome,
        session,
        ...fastControls,
        maxRetries: 3,
        removeEntry: remove,
      });
      expect(outcome.cleaned).toBe(true);
      await expect(
        access(path.dirname(session.workspacePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refuses cleanup when the on-disk marker sessionId is forged', async () => {
    const { stackHome, session } = await prepared(await temp(), 'forgeid1');
    const sessionRoot = path.dirname(session.workspacePath);
    const marker = JSON.parse(
      await readFile(path.join(sessionRoot, 'session.json'), 'utf8'),
    );
    await writeFile(
      path.join(sessionRoot, 'session.json'),
      JSON.stringify({ ...marker, sessionId: 'try_forged99' }),
    );
    await expect(
      cleanupCodexTryRuntime({ stackHome, session }),
    ).rejects.toMatchObject({ code: 'try-runtime-cleanup-failed' });
    await expect(access(sessionRoot)).resolves.toBeUndefined();
  });

  it('refuses cleanup when the on-disk marker paths are forged', async () => {
    const { stackHome, session } = await prepared(await temp(), 'forgepath1');
    const sessionRoot = path.dirname(session.workspacePath);
    const marker = JSON.parse(
      await readFile(path.join(sessionRoot, 'session.json'), 'utf8'),
    );
    await writeFile(
      path.join(sessionRoot, 'session.json'),
      JSON.stringify({
        ...marker,
        workspacePath: path.join(sessionRoot, '..', 'elsewhere'),
      }),
    );
    await expect(
      cleanupCodexTryRuntime({ stackHome, session }),
    ).rejects.toMatchObject({ code: 'try-runtime-cleanup-failed' });
    await expect(access(sessionRoot)).resolves.toBeUndefined();
  });

  it('cleans only after the launched child has closed', async () => {
    const { stackHome, session, preparation } = await prepared(
      await temp(),
      'lifecycle1',
    );
    let statusWhileRunning: string | undefined;
    let workspaceExisted = false;
    const result = await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: '/fake' },
      spawnProcess: async (_file, _args, spawnOptions) => {
        const marker = JSON.parse(
          await readFile(
            path.join(path.dirname(session.workspacePath), 'session.json'),
            'utf8',
          ),
        );
        statusWhileRunning = marker.status;
        workspaceExisted = await access(spawnOptions.cwd)
          .then(() => true)
          .catch(() => false);
        return { exitCode: 0, signal: null };
      },
    });
    expect(statusWhileRunning).toBe('running');
    expect(workspaceExisted).toBe(true);
    expect(result.cleaned).toBe(true);
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans safely when the child is terminated by a signal', async () => {
    const { stackHome, session, preparation } = await prepared(
      await temp(),
      'signalpath1',
    );
    const result = await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: '/fake' },
      spawnProcess: async () => ({ exitCode: null, signal: 'SIGINT' }),
    });
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGINT',
      cleaned: true,
    });
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves zero runtime directories after a successful trial', async () => {
    const { stackHome, preparation } = await prepared(
      await temp(),
      'zerodirs1',
    );
    await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: '/fake' },
      spawnProcess: async () => ({ exitCode: 0, signal: null }),
    });
    expect(await readdir(path.join(stackHome, 'runtime'))).toEqual([]);
  });

  it('controlled reproduction: transient workspace failure retries, then fully cleans a real shim launch', async () => {
    const root = await temp();
    const shim = await makeCodexShim(path.join(root, 'bin'));
    const { stackHome, session, preparation } = await prepared(
      root,
      'winrepro1',
    );
    const fencedHome = path.join(root, 'real');
    const { remove, attemptsFor } = recordingRemover((target, attempt) => {
      if (target === session.workspacePath && attempt === 1)
        throw fsError('EPERM');
    });
    const result = await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: shim },
      env: {
        ...process.env,
        HOME: fencedHome,
        USERPROFILE: fencedHome,
        CODEX_HOME: path.join(fencedHome, '.codex'),
      },
      cleanup: { removeEntry: remove, ...fastControls },
    });
    // The real shim actually ran inside the isolated workspace.
    expect(result.cleaned).toBe(true);
    expect(attemptsFor(session.workspacePath)).toBeGreaterThanOrEqual(2);
    expect(await readdir(path.join(stackHome, 'runtime'))).toEqual([]);
  });

  it('controlled reproduction: permanent workspace failure retains a cleanup-failed runtime', async () => {
    const root = await temp();
    const shim = await makeCodexShim(path.join(root, 'bin'));
    const { stackHome, session, preparation } = await prepared(
      root,
      'winrepro2',
    );
    const fencedHome = path.join(root, 'real');
    const result = await launchCodexTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'codex', installed: true, executablePath: shim },
      env: {
        ...process.env,
        HOME: fencedHome,
        USERPROFILE: fencedHome,
        CODEX_HOME: path.join(fencedHome, '.codex'),
      },
      cleanup: {
        ...fastControls,
        maxRetries: 2,
        removeEntry: async (target) => {
          if (target === session.workspacePath) throw fsError('EPERM');
          await rm(target, { recursive: true, force: true });
        },
      },
    });
    expect(result.cleaned).toBe(false);
    expect(result.cleanup).toMatchObject({
      component: 'workspace',
      code: 'EPERM',
    });
    const sessionRoot = path.dirname(session.workspacePath);
    expect(result.retainedRuntimePath).toBe(sessionRoot);
    await expect(
      access(path.join(sessionRoot, 'session.json')),
    ).resolves.toBeUndefined();
    const marker = JSON.parse(
      await readFile(path.join(sessionRoot, 'session.json'), 'utf8'),
    );
    expect(marker.status).toBe('cleanup-failed');
  });
});

const SAMPLE_CONFIG = [
  '# personal Codex config',
  'model = "gpt-5-codex"',
  'model_provider = "openai"',
  '',
  '[model_providers.openai]',
  'name = "OpenAI"',
  '',
  '[[marketplaces]]',
  'name = "claude-mem"',
  'source = "https://github.com/thedotmack/claude-mem.git"',
  '',
  '[plugins.claude-mem]',
  'enabled = true',
  '',
  '[hooks]',
  'on_start = "git pull"',
  '',
  '[history]',
  'persistence = "save-all"',
  '',
].join('\n');

describe('Codex config isolation (plugin marketplace leakage)', () => {
  it('strips marketplace/plugin/hook tables but preserves model and other config', () => {
    const sanitized = sanitizeCodexConfigToml(SAMPLE_CONFIG);
    expect(sanitized).toContain('model = "gpt-5-codex"');
    expect(sanitized).toContain('[model_providers.openai]');
    expect(sanitized).toContain('name = "OpenAI"');
    expect(sanitized).toContain('[history]');
    expect(sanitized).toContain('# personal Codex config');
    expect(sanitized).not.toContain('marketplaces');
    expect(sanitized).not.toContain('claude-mem');
    expect(sanitized).not.toContain('thedotmack');
    expect(sanitized).not.toContain('[plugins');
    expect(sanitized).not.toContain('[hooks]');
    expect(sanitized).not.toContain('on_start');
  });

  it('strips a root-level plugins assignment and singular marketplace table', () => {
    const sanitized = sanitizeCodexConfigToml(
      [
        'model = "x"',
        'plugins = ["a", "b"]',
        '[marketplace]',
        'url = "https://example.com"',
        '[keep]',
        'value = 1',
      ].join('\n'),
    );
    expect(sanitized).toContain('model = "x"');
    expect(sanitized).toContain('[keep]');
    expect(sanitized).toContain('value = 1');
    expect(sanitized).not.toContain('plugins = ');
    expect(sanitized).not.toContain('[marketplace]');
    expect(sanitized).not.toContain('example.com');
  });

  it('does not strip an excluded key name used inside a kept table', () => {
    const sanitized = sanitizeCodexConfigToml(
      ['[registry]', 'marketplace = "internal"'].join('\n'),
    );
    expect(sanitized).toContain('[registry]');
    expect(sanitized).toContain('marketplace = "internal"');
  });

  it('bridges a sanitized config, keeps auth verbatim, and never mutates the real config', async () => {
    const root = await temp();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'config.toml'), SAMPLE_CONFIG);
    await writeFile(path.join(source, 'auth.json'), 'sentinel-secret');
    const sourceConfigBefore = await readFile(
      path.join(source, 'config.toml'),
      'utf8',
    );

    const copied = await bridgeCodexRuntimeState({
      sourceCodexHome: source,
      runtimeCodexHome: target,
    });
    expect(copied).toEqual(['auth.json', 'config.toml']);

    const bridgedConfig = await readFile(
      path.join(target, 'config.toml'),
      'utf8',
    );
    expect(bridgedConfig).toContain('model = "gpt-5-codex"');
    expect(bridgedConfig).not.toContain('marketplaces');
    expect(bridgedConfig).not.toContain('claude-mem');
    expect(bridgedConfig).not.toContain('[plugins');
    // auth.json copied byte-for-byte.
    expect(await readFile(path.join(target, 'auth.json'), 'utf8')).toBe(
      'sentinel-secret',
    );
    // Real user config is never modified.
    expect(await readFile(path.join(source, 'config.toml'), 'utf8')).toBe(
      sourceConfigBefore,
    );
  });

  it('a prepared trial codex-home contains no personal marketplace/plugin config', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real');
    await mkdir(path.join(realHome, '.codex'), { recursive: true });
    await writeFile(
      path.join(realHome, '.codex', 'config.toml'),
      SAMPLE_CONFIG,
    );
    await writeFile(
      path.join(realHome, '.codex', 'auth.json'),
      'sentinel-secret',
    );
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      idFactory: () => 'noplugins1',
    });
    const bridgedConfig = await readFile(
      path.join(preparation.session.runtimeCodexHomePath!, 'config.toml'),
      'utf8',
    );
    expect(bridgedConfig).not.toContain('marketplaces');
    expect(bridgedConfig).not.toContain('claude-mem');
    expect(bridgedConfig).not.toContain('[plugins');
    expect(bridgedConfig).toContain('model = "gpt-5-codex"');
    // Trial Skills still materialized; auth still bridged.
    expect(preparation.session.resolvedSkills).toHaveLength(1);
    expect(
      await readFile(
        path.join(preparation.session.runtimeCodexHomePath!, 'auth.json'),
        'utf8',
      ),
    ).toBe('sentinel-secret');
    // Real config untouched.
    expect(
      await readFile(path.join(realHome, '.codex', 'config.toml'), 'utf8'),
    ).toBe(SAMPLE_CONFIG);
    await cleanupCodexTryRuntime({
      stackHome,
      session: preparation.session,
      ...fastControls,
    });
  });
});

describe('stale cleanup-failed runtime recovery', () => {
  const preparedRuntime = async (root: string, id: string) => {
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => id,
    });
    return { stackHome, session: preparation.session };
  };
  const driveToCleanupFailed = async (
    stackHome: string,
    session: TrySession,
  ) => {
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      maxRetries: 2,
      removeEntry: async (target) => {
        if (target === session.workspacePath) throw fsError('EBUSY');
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(outcome.cleaned).toBe(false);
  };

  it('retries a valid cleanup-failed runtime and removes the marker last', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'stalerec01',
    );
    await driveToCleanupFailed(stackHome, session);
    const { remove, calls } = recordingRemover();
    const result = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
      removeEntry: remove,
    });
    expect(result).toMatchObject({ scanned: 1, cleaned: 1, retained: 0 });
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.at(-1)).toBe(
      path.join(path.dirname(session.workspacePath), 'session.json'),
    );
  });

  it('keeps a still-busy stale runtime marked', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'stalerec02',
    );
    await driveToCleanupFailed(stackHome, session);
    const result = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
      maxRetries: 2,
      removeEntry: async (target) => {
        if (target === session.workspacePath) throw fsError('EBUSY');
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(result).toMatchObject({ scanned: 1, cleaned: 0, retained: 1 });
    const marker = JSON.parse(
      await readFile(
        path.join(path.dirname(session.workspacePath), 'session.json'),
        'utf8',
      ),
    );
    expect(marker.status).toBe('cleanup-failed');
  });

  it('ignores an unmarked stale directory', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const junk = path.join(stackHome, 'runtime', 'try_unmarked1');
    await mkdir(path.join(junk, 'workspace'), { recursive: true });
    const result = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
    });
    expect(result.scanned).toBe(0);
    await expect(access(junk)).resolves.toBeUndefined();
  });

  it('does not touch a ready (non-cleanup-failed) runtime', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'readyruntime1',
    );
    const result = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
    });
    expect(result.scanned).toBe(0);
    await expect(
      access(path.dirname(session.workspacePath)),
    ).resolves.toBeUndefined();
  });

  it('ignores a runtime whose marker id is forged', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'forgedrec01',
    );
    await driveToCleanupFailed(stackHome, session);
    const sessionRoot = path.dirname(session.workspacePath);
    const marker = JSON.parse(
      await readFile(path.join(sessionRoot, 'session.json'), 'utf8'),
    );
    await writeFile(
      path.join(sessionRoot, 'session.json'),
      JSON.stringify({ ...marker, sessionId: 'try_forged99' }),
    );
    const result = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
    });
    expect(result.scanned).toBe(0);
    await expect(access(sessionRoot)).resolves.toBeUndefined();
  });
});

describe('controlled descendant reproduction', () => {
  const preparedRuntime = async (root: string, id: string) => {
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => id,
    });
    return { stackHome, session: preparation.session };
  };

  it('short-lived descendant: settle + bounded retry completes cleanup', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'shortlived1',
    );
    const { remove, attemptsFor } = recordingRemover((target, attempt) => {
      if (target === session.workspacePath && attempt === 1)
        throw fsError('EBUSY');
    });
    const outcome = await cleanupCodexTryRuntime({
      stackHome,
      session,
      ...fastControls,
      settleDelayMs: 0,
      removeEntry: remove,
    });
    expect(outcome.cleaned).toBe(true);
    expect(attemptsFor(session.workspacePath)).toBe(2);
    await expect(
      access(path.dirname(session.workspacePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('long-lived descendant: retains marker, never terminates the process, recovers later', async () => {
    const { stackHome, session } = await preparedRuntime(
      await temp(),
      'longlived01',
    );
    // A real detached descendant that outlives cleanup.
    const sleeper = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      { detached: true, stdio: 'ignore' },
    );
    sleeper.unref();
    try {
      const outcome = await cleanupCodexTryRuntime({
        stackHome,
        session,
        ...fastControls,
        maxRetries: 2,
        removeEntry: async (target) => {
          if (target === session.workspacePath) throw fsError('EBUSY');
          await rm(target, { recursive: true, force: true });
        },
      });
      expect(outcome.cleaned).toBe(false);
      // Stack never force-terminates descendants.
      expect(() => process.kill(sleeper.pid ?? -1, 0)).not.toThrow();
      // Once the descendant is gone, a later trial's recovery cleans it up.
      const result = await recoverStaleTryRuntimes({
        stackHome,
        ...fastControls,
      });
      expect(result).toMatchObject({ scanned: 1, cleaned: 1 });
      await expect(
        access(path.dirname(session.workspacePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      try {
        process.kill(sleeper.pid ?? -1, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  });

  it('a later real-shim trial recovers a prior cleanup-failed runtime and proceeds', async () => {
    const root = await temp();
    const shim = await makeCodexShim(path.join(root, 'bin'));
    const stackHome = path.join(root, 'stack');
    const fenced = {
      ...process.env,
      HOME: path.join(root, 'real'),
      USERPROFILE: path.join(root, 'real'),
      CODEX_HOME: path.join(root, 'real', '.codex'),
    };
    const trial = await storedTrial(stackHome);
    const first = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => 'crosstrialA',
    });
    const firstResult = await launchCodexTryRuntime({
      stackHome,
      preparation: first,
      detection: { agent: 'codex', installed: true, executablePath: shim },
      env: fenced,
      cleanup: {
        ...fastControls,
        maxRetries: 2,
        removeEntry: async (target) => {
          if (target === first.session.workspacePath) throw fsError('EBUSY');
          await rm(target, { recursive: true, force: true });
        },
      },
    });
    expect(firstResult.cleaned).toBe(false);
    expect(await readdir(path.join(stackHome, 'runtime'))).toContain(
      'try_crosstrialA',
    );
    // Later trial: recovery (as wired before prepare) clears the prior runtime.
    const recovery = await recoverStaleTryRuntimes({
      stackHome,
      ...fastControls,
    });
    expect(recovery).toMatchObject({ scanned: 1, cleaned: 1 });
    const second = await prepareCodexTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => 'crosstrialB',
    });
    const secondResult = await launchCodexTryRuntime({
      stackHome,
      preparation: second,
      detection: { agent: 'codex', installed: true, executablePath: shim },
      env: fenced,
      cleanup: fastControls,
    });
    expect(secondResult.cleaned).toBe(true);
    expect(await readdir(path.join(stackHome, 'runtime'))).toEqual([]);
  });
});

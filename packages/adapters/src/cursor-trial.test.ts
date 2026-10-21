import {
  access,
  mkdir as filesystemMkdir,
  readFile,
  stat,
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
  bridgeCursorLoginSession,
  bridgeCursorRuntimeState,
  cleanupCursorTryRuntime,
  cursorLoginSessionExists,
  launchCursorTryRuntime,
  prepareCursorTryRuntime,
  recoverStaleCursorTryRuntimes,
  resolveCursorAuthFilePath,
} from './cursor-trial.js';

const onWindows = process.platform === 'win32';
const onMac = process.platform === 'darwin';

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
    environment: {
      name: 'try:trial',
      skills,
      skipped: [],
      conflicts: [],
      renamed: [],
    },
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
    await writeFile(path.join(source, 'cli-config.json'), '{"editor":"vim"}');
    await writeFile(path.join(source, 'auth-session.bin'), 'undocumented');
    expect(
      await bridgeCursorRuntimeState({
        sourceCursorHome: source,
        runtimeCursorHome: target,
      }),
    ).toEqual(['cli-config.json']);
    expect(await readFile(path.join(target, 'cli-config.json'), 'utf8')).toBe(
      '{"editor":"vim"}',
    );
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

  it('refuses to launch when neither CURSOR_API_KEY/CURSOR_AUTH_TOKEN nor a real `agent login` session exists, and still cleans up', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const realHome = path.join(root, 'real');
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      idFactory: () => 'cursor003',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    let spawned = false;
    await expect(
      launchCursorTryRuntime({
        stackHome,
        preparation,
        detection: {
          agent: 'cursor',
          installed: true,
          executablePath: '/fake',
        },
        // An isolated, guaranteed-empty HOME — proves the fallback to the
        // *test runner's own* machine HOME can never leak a real login
        // session into this assertion (see the next test for the opposite).
        env: { HOME: realHome, USERPROFILE: realHome },
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
        detection: {
          agent: 'cursor',
          installed: true,
          executablePath: '/fake',
        },
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

describe('Cursor `agent login` session detection and bridging', () => {
  it('resolveCursorAuthFilePath prefers APPDATA over a homeDir-derived default on Windows', () => {
    if (!onWindows) return;
    expect(
      resolveCursorAuthFilePath({
        homeDir: 'C:\\Users\\nobody',
        env: { APPDATA: 'C:\\Custom\\AppData' },
      }),
    ).toBe(path.join('C:\\Custom\\AppData', 'Cursor', 'auth.json'));
    expect(
      resolveCursorAuthFilePath({ homeDir: 'C:\\Users\\nobody', env: {} }),
    ).toBe(
      path.join(
        'C:\\Users\\nobody',
        'AppData',
        'Roaming',
        'Cursor',
        'auth.json',
      ),
    );
  });

  it('resolveCursorAuthFilePath matches the macOS/Linux layout off this platform', () => {
    if (onWindows) return;
    if (onMac)
      expect(
        resolveCursorAuthFilePath({ homeDir: '/Users/nobody', env: {} }),
      ).toBe(path.join('/Users/nobody', '.cursor', 'auth.json'));
    else
      expect(
        resolveCursorAuthFilePath({ homeDir: '/home/nobody', env: {} }),
      ).toBe(path.join('/home/nobody', '.config', 'cursor', 'auth.json'));
  });

  it('cursorLoginSessionExists is a pure existence check: true for a real file, false otherwise', async () => {
    const root = await temp();
    const present = path.join(root, 'present', 'auth.json');
    await mkdir(path.dirname(present), { recursive: true });
    await writeFile(present, '{"accessToken":"sentinel-should-never-be-read"}');
    expect(await cursorLoginSessionExists(present)).toBe(true);
    expect(
      await cursorLoginSessionExists(path.join(root, 'missing.json')),
    ).toBe(false);
  });

  it('bridgeCursorLoginSession is always a no-op on Windows, even when a real session exists', async () => {
    if (!onWindows) return;
    const root = await temp();
    const realAuthFilePath = path.join(root, 'appdata', 'Cursor', 'auth.json');
    await mkdir(path.dirname(realAuthFilePath), { recursive: true });
    await writeFile(realAuthFilePath, '{"accessToken":"sentinel-secret"}');
    const runtimeHomePath = path.join(root, 'runtime-home');
    await mkdir(runtimeHomePath, { recursive: true });
    expect(
      await bridgeCursorLoginSession({ realAuthFilePath, runtimeHomePath }),
    ).toBe(false);
    await expect(
      access(path.join(runtimeHomePath, 'AppData')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  (onWindows ? it.skip : it)(
    'bridgeCursorLoginSession copies only the session file, mode 0600, off Windows',
    async () => {
      const root = await temp();
      const realAuthFilePath = path.join(root, 'home', '.cursor', 'auth.json');
      await mkdir(path.dirname(realAuthFilePath), { recursive: true });
      await writeFile(realAuthFilePath, '{"accessToken":"sentinel-secret"}');
      const runtimeHomePath = path.join(root, 'runtime-home');
      await mkdir(runtimeHomePath, { recursive: true });
      const bridged = await bridgeCursorLoginSession({
        realAuthFilePath,
        runtimeHomePath,
      });
      expect(bridged).toBe(true);
      const target = onMac
        ? path.join(runtimeHomePath, '.cursor', 'auth.json')
        : path.join(runtimeHomePath, '.config', 'cursor', 'auth.json');
      expect(await readFile(target, 'utf8')).toBe(
        '{"accessToken":"sentinel-secret"}',
      );
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  it('bridgeCursorLoginSession returns false, and copies nothing, when no real session exists', async () => {
    const root = await temp();
    const runtimeHomePath = path.join(root, 'runtime-home');
    await mkdir(runtimeHomePath, { recursive: true });
    expect(
      await bridgeCursorLoginSession({
        realAuthFilePath: path.join(root, 'home', 'nonexistent', 'auth.json'),
        runtimeHomePath,
      }),
    ).toBe(false);
  });

  it('launches without CURSOR_API_KEY/CURSOR_AUTH_TOKEN when a real `agent login` session is detected', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const realHome = path.join(root, 'real');
    // Simulate a genuine `agent login` session at exactly the path the real
    // CLI (and our own resolver) would use for this platform — written
    // *before* prepare, matching production order (login already happened).
    const sharedEnv: NodeJS.ProcessEnv = onWindows
      ? {
          HOME: realHome,
          USERPROFILE: realHome,
          APPDATA: path.join(realHome, 'AppData', 'Roaming'),
        }
      : { HOME: realHome, USERPROFILE: realHome };
    const realAuthFilePath = resolveCursorAuthFilePath({
      homeDir: realHome,
      env: sharedEnv,
    });
    await mkdir(path.dirname(realAuthFilePath), { recursive: true });
    await writeFile(realAuthFilePath, '{"accessToken":"sentinel-secret"}');
    const preparation = await prepareCursorTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      env: sharedEnv,
      idFactory: () => 'cursor-login-001',
    });
    if (!onWindows) {
      // Bridged into the isolated HOME during prepare, since the real CLI's
      // auth.json lookup there is HOME-relative and HOME is isolated.
      const bridgedTarget = onMac
        ? path.join(preparation.session.runtimeHomePath, '.cursor', 'auth.json')
        : path.join(
            preparation.session.runtimeHomePath,
            '.config',
            'cursor',
            'auth.json',
          );
      expect(await readFile(bridgedTarget, 'utf8')).toBe(
        '{"accessToken":"sentinel-secret"}',
      );
    }
    let spawned = false;
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const result = await launchCursorTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'cursor', installed: true, executablePath: '/fake' },
      env: sharedEnv,
      spawnProcess: async (_file, _args, options) => {
        spawned = true;
        observedEnv = options.env;
        return { exitCode: 0, signal: null };
      },
    });
    expect(spawned).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, cleaned: true });
    // No secret is ever forwarded as CURSOR_API_KEY/CURSOR_AUTH_TOKEN, logged,
    // or otherwise surfaced — the official CLI finds the (possibly bridged)
    // auth.json itself.
    expect(observedEnv?.CURSOR_API_KEY).toBeUndefined();
    expect(observedEnv?.CURSOR_AUTH_TOKEN).toBeUndefined();
  });
});

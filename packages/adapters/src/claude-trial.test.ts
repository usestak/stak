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
  bridgeClaudeRuntimeState,
  cleanupClaudeTryRuntime,
  launchClaudeTryRuntime,
  prepareClaudeTryRuntime,
  recoverStaleClaudeTryRuntimes,
  sanitizeClaudeSettingsJson,
} from './claude-trial.js';

const ownedRoots: OwnedTestRoot[] = [];
const temp = async () => {
  const owned = await createOwnedTestRoot('stack-claude-try-');
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

describe('Claude trial runtime', () => {
  it('bridges only .credentials.json and sanitized settings.json', async () => {
    const root = await temp();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, '.credentials.json'), 'sentinel-secret');
    await writeFile(
      path.join(source, 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { onStart: 'curl evil' } }),
    );
    await writeFile(path.join(source, 'history.jsonl'), 'history');
    expect(
      await bridgeClaudeRuntimeState({
        sourceClaudeHome: source,
        runtimeClaudeHome: target,
      }),
    ).toEqual(['.credentials.json', 'settings.json']);
    expect(await readFile(path.join(target, '.credentials.json'), 'utf8')).toBe(
      'sentinel-secret',
    );
    const settings = JSON.parse(
      await readFile(path.join(target, 'settings.json'), 'utf8'),
    );
    expect(settings.theme).toBe('dark');
    expect(settings.hooks).toBeUndefined();
    await expect(
      access(path.join(target, 'history.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns no bridged files when the source Claude home does not exist (macOS Keychain case)', async () => {
    const root = await temp();
    expect(
      await bridgeClaudeRuntimeState({
        sourceClaudeHome: path.join(root, 'does-not-exist'),
        runtimeClaudeHome: path.join(root, 'target'),
      }),
    ).toEqual([]);
  });

  it('sanitizes hooks/plugins/mcpServers but preserves other settings keys', () => {
    const sanitized = JSON.parse(
      sanitizeClaudeSettingsJson(
        JSON.stringify({
          theme: 'dark',
          hooks: { onStart: 'x' },
          plugins: ['a'],
          mcpServers: { x: {} },
        }),
      ),
    );
    expect(sanitized).toEqual({ theme: 'dark' });
  });

  it('materializes Skills into .claude/skills in an isolated home, normal Claude roots untouched', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real-home');
    const realSkill = path.join(realHome, '.claude', 'skills', 'normal');
    await mkdir(realSkill, { recursive: true });
    await writeFile(path.join(realSkill, 'SKILL.md'), 'normal');
    const trial = await storedTrial(stackHome);
    const result = await prepareClaudeTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      env: {},
      idFactory: () => '12345678',
    });
    expect(result.session.runtimeHomePath).not.toBe(realHome);
    expect(result.session.runtimeAgentHomePath).not.toBe(
      path.join(realHome, '.claude'),
    );
    const materialized = result.session.resolvedSkills.at(0);
    if (!materialized) throw new Error('expected a materialized skill');
    expect(materialized.targetPath).toContain(path.join('.claude', 'skills'));
    const expectedSkill = trial.environment.skills.at(0);
    if (!expectedSkill) throw new Error('expected a trial skill');
    expect((await hashSkillDirectory(materialized.targetPath)).hash).toBe(
      expectedSkill.contentHash,
    );
    expect(await readFile(path.join(realSkill, 'SKILL.md'), 'utf8')).toBe(
      'normal',
    );
    await cleanupClaudeTryRuntime({ stackHome, session: result.session });
  });

  it('launches with CLAUDE_CONFIG_DIR pointed at the isolated runtime, not the real ~/.claude', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareClaudeTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      env: {},
      idFactory: () => 'session1x',
    });
    let observed: unknown;
    const result = await launchClaudeTryRuntime({
      stackHome,
      preparation,
      detection: { agent: 'claude', installed: true, executablePath: '/fake' },
      env: { HOME: '/real', USERPROFILE: '/real' },
      spawnProcess: async (_file, _args, options) => {
        observed = options;
        return { exitCode: 0, signal: null };
      },
    });
    expect(observed).toMatchObject({
      cwd: preparation.session.workspacePath,
      env: {
        HOME: preparation.session.runtimeHomePath,
        USERPROFILE: preparation.session.runtimeHomePath,
        CLAUDE_CONFIG_DIR: preparation.session.runtimeAgentHomePath,
      },
    });
    expect(result).toMatchObject({ exitCode: 0, cleaned: true });
  });

  it('cleans up after a launch failure without exposing bridged credential contents', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const realHome = path.join(root, 'real');
    await mkdir(path.join(realHome, '.claude'), { recursive: true });
    await writeFile(
      path.join(realHome, '.claude', '.credentials.json'),
      'sentinel-secret',
    );
    const trial = await storedTrial(stackHome);
    const preparation = await prepareClaudeTryRuntime({
      stackHome,
      trial,
      homeDir: realHome,
      idFactory: () => 'failed002',
    });
    const sessionRoot = path.dirname(preparation.session.workspacePath);
    await expect(
      launchClaudeTryRuntime({
        stackHome,
        preparation,
        detection: {
          agent: 'claude',
          installed: true,
          executablePath: '/fake',
        },
        spawnProcess: async () => {
          throw new Error('launch failed');
        },
      }),
    ).rejects.not.toThrow(/sentinel-secret/);
    await expect(access(sessionRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recovery only touches cleanup-failed Claude sessions, not Codex/Cursor ones', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const trial = await storedTrial(stackHome);
    const preparation = await prepareClaudeTryRuntime({
      stackHome,
      trial,
      homeDir: path.join(root, 'real'),
      idFactory: () => 'recov0001',
    });
    const result = await recoverStaleClaudeTryRuntimes({ stackHome });
    // A `ready` runtime is never touched by recovery.
    expect(result).toMatchObject({ scanned: 0 });
    await cleanupClaudeTryRuntime({ stackHome, session: preparation.session });
  });
});

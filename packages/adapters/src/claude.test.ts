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

import { hashSkillDirectory } from '@stack/shared';
import type { AgentDetection, ResolvedLocalEnvironment } from '@stack/spec';
import { ingestSkill, materializeStoredSkill } from '@stack/store';

import { ClaudeAdapter, detectClaude } from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-claude-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const makeSkill = async (directory: string, name: string, body: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\n---\n${body}\n`,
  );
  return (await hashSkillDirectory(directory)).hash;
};

const machineId = '00000000-0000-4000-8000-000000000000';
const setup = async () => {
  const root = await temp();
  const homeDir = path.join(root, 'home');
  const stackHome = path.join(root, 'stack');
  const source = path.join(root, 'source', 'foo');
  const contentHash = await makeSkill(source, 'foo', 'desired');
  await ingestSkill({
    stackHome,
    sourcePath: source,
    expectedContentHash: contentHash,
  });
  const environment: ResolvedLocalEnvironment = {
    name: 'main',
    machineId,
    skills: [{ entryId: 'skill_12345678', name: 'foo', contentHash }],
  };
  return { root, homeDir, stackHome, contentHash, environment };
};

describe('Claude detection', () => {
  it('probes `claude --version` without shell and reports installation', async () => {
    let file = '';
    let args: string[] = [];
    const result = await detectClaude({
      findExecutable: async (name) =>
        name === 'claude' ? '/bin/claude' : undefined,
      runVersion: async (value, probe) => {
        file = value;
        args = probe;
        return 'claude 1.0.0 (Claude Code)';
      },
    });
    expect(file).toBe('/bin/claude');
    expect(args).toEqual(['--version']);
    expect(result).toMatchObject({
      agent: 'claude',
      installed: true,
      executablePath: '/bin/claude',
      version: 'claude 1.0.0 (Claude Code)',
    });
  });

  it('reports Claude missing when the executable is absent', async () => {
    expect(
      await detectClaude({ findExecutable: async () => undefined }),
    ).toEqual({
      agent: 'claude',
      installed: false,
    });
  });
});

describe('Claude personal binding', () => {
  it('uses ~/.claude/skills anchored to HOME regardless of STACK_HOME', async () => {
    const root = await temp();
    const homeDir = path.join(root, 'home');
    const claude = new ClaudeAdapter({
      stackHome: path.join(root, 'unrelated-stack-home'),
      homeDir,
    });
    const plan = await claude.planBindings({
      name: 'main',
      machineId,
      skills: [],
    });
    expect(plan.targetRoot).toBe(path.join(homeDir, '.claude', 'skills'));
  });

  it('externally satisfies an exact unmanaged personal target without ownership', async () => {
    const state = await setup();
    const target = path.join(state.homeDir, '.claude', 'skills', 'foo');
    await mkdir(path.dirname(target), { recursive: true });
    await materializeStoredSkill({
      stackHome: state.stackHome,
      contentHash: state.contentHash,
      targetPath: target,
    });
    const claude = new ClaudeAdapter(state);
    const plan = await claude.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('externally-satisfied');
    expect(plan.blocking).toBe(false);
  });

  it('reports a differing unmanaged personal target as conflict-unmanaged', async () => {
    const state = await setup();
    const target = path.join(state.homeDir, '.claude', 'skills', 'foo');
    await makeSkill(target, 'foo', 'hand-authored bytes');
    const before = await readFile(path.join(target, 'SKILL.md'), 'utf8');
    const claude = new ClaudeAdapter(state);
    const plan = await claude.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('conflict-unmanaged');
    expect(plan.blocking).toBe(true);
    await expect(claude.applyBindings(plan, machineId)).rejects.toThrow();
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('never writes project .claude/skills or Claude plugin directories', async () => {
    const state = await setup();
    const projectSkills = path.join(state.root, 'project', '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    const pluginSentinel = path.join(
      state.homeDir,
      '.claude',
      'plugins',
      'vendor',
      'skills',
      'foo',
    );
    await makeSkill(pluginSentinel, 'foo', 'plugin bytes');
    const before = await readFile(
      path.join(pluginSentinel, 'SKILL.md'),
      'utf8',
    );
    const claude = new ClaudeAdapter(state);
    await claude.applyBindings(
      await claude.planBindings(state.environment),
      machineId,
    );
    // Personal root written, project + plugin roots untouched.
    expect(
      (
        await hashSkillDirectory(
          path.join(state.homeDir, '.claude', 'skills', 'foo'),
        )
      ).hash,
    ).toBe(state.contentHash);
    await expect(stat(path.join(projectSkills, 'foo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(pluginSentinel, 'SKILL.md'), 'utf8')).toBe(
      before,
    );
  });

  it('launches Claude preserving HOME, CLAUDE_CONFIG_DIR, ANTHROPIC_* and cwd', async () => {
    const state = await setup();
    const detection: AgentDetection = {
      agent: 'claude',
      installed: true,
      executablePath: '/bin/claude',
    };
    let captured:
      | { file: string; options: { cwd: string; env: NodeJS.ProcessEnv } }
      | undefined;
    const claude = new ClaudeAdapter({
      ...state,
      detect: async () => detection,
      spawnProcess: async (file, _args, options) => {
        captured = { file, options };
        return { exitCode: 3, signal: null };
      },
    });
    const env = {
      HOME: '/real/home',
      USERPROFILE: 'C:/Users/real',
      CLAUDE_CONFIG_DIR: '/cfg/claude',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
    };
    const result = await claude.launch({ cwd: '/repo', env });
    expect(result.exitCode).toBe(3);
    expect(captured?.file).toBe('/bin/claude');
    expect(captured?.options).toMatchObject({
      cwd: '/repo',
      shell: false,
      stdio: 'inherit',
      env,
    });
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashSkillDirectory } from '@stack/shared';
import type { ResolvedLocalEnvironment } from '@stack/spec';
import { ingestSkill } from '@stack/store';
import {
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  bindingRegistryPath,
  detectClaude,
  detectCursor,
  readBindingRegistry,
} from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-agents-'));
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
    machineId: '00000000-0000-4000-8000-000000000000',
    skills: [{ entryId: 'skill_12345678', name: 'foo', contentHash }],
  };
  return { root, homeDir, stackHome, contentHash, environment };
};

describe('multi-agent filesystem adapters', () => {
  it('prefers a validated agent executable and falls back to cursor-agent', async () => {
    const calls: string[] = [];
    const found = {
      agent: '/bin/agent',
      'cursor-agent': '/bin/cursor-agent',
    } as Record<string, string>;
    const result = await detectCursor({
      findExecutable: async (name) => found[name],
      runVersion: async (file) => {
        calls.push(file);
        return file.endsWith('/agent') ? 'unrelated 1.0' : 'Cursor Agent 2.0';
      },
    });
    expect(calls).toEqual(['/bin/agent', '/bin/cursor-agent']);
    expect(result.executablePath).toBe('/bin/cursor-agent');
  });

  it('detects Claude without entering interactive mode', async () => {
    let args: string[] = [];
    const result = await detectClaude({
      findExecutable: async () => '/bin/claude',
      runVersion: async (_file, value) => {
        args = value;
        return 'claude 1.0';
      },
    });
    expect(args).toEqual(['--version']);
    expect(result).toMatchObject({ agent: 'claude', installed: true });
  });

  it('shares one agents-root ownership record between Codex and Cursor', async () => {
    const state = await setup();
    const codex = new CodexAdapter(state);
    const cursor = new CursorAdapter(state);
    const plan = await codex.planBindings(state.environment);
    await codex.applyBindings(plan, state.environment.machineId);
    const cursorPlan = await cursor.planBindings(state.environment);
    expect(cursorPlan.operations[0]?.state).toBe('already-managed');
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId: state.environment.machineId,
    });
    expect(registry.bindings).toHaveLength(1);
    expect(registry.bindings[0]?.targetRoot).toBe('agents');
  });

  it('uses a separate Claude physical binding while reusing Store content', async () => {
    const state = await setup();
    const codex = new CodexAdapter(state);
    const claude = new ClaudeAdapter(state);
    await codex.applyBindings(
      await codex.planBindings(state.environment),
      state.environment.machineId,
    );
    await claude.applyBindings(
      await claude.planBindings(state.environment),
      state.environment.machineId,
    );
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId: state.environment.machineId,
    });
    expect(registry.bindings.map((item) => item.targetRoot).sort()).toEqual([
      'agents',
      'claude',
    ]);
    expect(
      await readFile(
        path.join(state.homeDir, '.claude', 'skills', 'foo', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('desired');
  });

  it('reports Cursor cross-root conflicts and never mutates the sync-capable root', async () => {
    const state = await setup();
    const sentinel = path.join(state.homeDir, '.cursor', 'skills', 'foo');
    await makeSkill(sentinel, 'foo', 'private sentinel');
    const before = await readFile(path.join(sentinel, 'SKILL.md'), 'utf8');
    const cursor = new CursorAdapter(state);
    const plan = await cursor.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('visibility-conflict');
    expect(plan.blocking).toBe(true);
    expect(await readFile(path.join(sentinel, 'SKILL.md'), 'utf8')).toBe(
      before,
    );
  });

  it('treats an exact compatibility-root copy as externally satisfied without ownership', async () => {
    const state = await setup();
    await makeSkill(
      path.join(state.homeDir, '.claude', 'skills', 'foo'),
      'foo',
      'desired',
    );
    const cursor = new CursorAdapter(state);
    const plan = await cursor.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('externally-satisfied');
    expect(
      await readFile(
        bindingRegistryPath(state.stackHome, state.environment.machineId),
        'utf8',
      ).catch(() => ''),
    ).toBe('');
  });
});

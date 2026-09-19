import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
  readBindingRegistry,
} from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-registry-'));
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

describe('shared machine binding registry', () => {
  it('lets Cursor create a shared binding that Codex then recognizes', async () => {
    const state = await setup();
    const cursor = new CursorAdapter(state);
    const codex = new CodexAdapter(state);
    await cursor.applyBindings(
      await cursor.planBindings(state.environment),
      machineId,
    );
    const codexPlan = await codex.planBindings(state.environment);
    expect(codexPlan.operations[0]?.state).toBe('already-managed');
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId,
    });
    expect(registry.bindings).toHaveLength(1);
    expect(registry.bindings[0]?.targetRoot).toBe('agents');
  });

  it('records exactly one ownership entry for one shared physical target', async () => {
    const state = await setup();
    const codex = new CodexAdapter(state);
    const cursor = new CursorAdapter(state);
    await codex.applyBindings(
      await codex.planBindings(state.environment),
      machineId,
    );
    // A Cursor reconcile of an already-managed target must not add a record.
    const cursorPlan = await cursor.planBindings(state.environment);
    expect(
      cursorPlan.operations.every((item) => item.state === 'already-managed'),
    ).toBe(true);
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId,
    });
    expect(registry.bindings).toHaveLength(1);
  });

  it('recognizes a shared binding through a redundantly expressed HOME path', async () => {
    const state = await setup();
    await new CodexAdapter(state).applyBindings(
      await new CodexAdapter(state).planBindings(state.environment),
      machineId,
    );
    const cursorAlias = new CursorAdapter({
      stackHome: state.stackHome,
      homeDir: path.join(state.homeDir, 'sub', '..'),
    });
    const plan = await cursorAlias.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('already-managed');
  });

  it('lets Cursor remove a healthy stale shared binding created by Codex', async () => {
    const state = await setup();
    await new CodexAdapter(state).applyBindings(
      await new CodexAdapter(state).planBindings(state.environment),
      machineId,
    );
    const cursor = new CursorAdapter(state);
    const plan = await cursor.planBindings({
      ...state.environment,
      skills: [],
    });
    expect(plan.operations).toMatchObject([
      { state: 'remove-managed', stale: true },
    ]);
    const result = await cursor.applyBindings(plan, machineId);
    expect(result.removed).toHaveLength(1);
    await expect(
      stat(path.join(state.homeDir, '.agents', 'skills', 'foo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId,
    });
    expect(registry.bindings).toEqual([]);
  });

  it('keeps Claude and shared roots independent across adapters', async () => {
    const state = await setup();
    const codex = new CodexAdapter(state);
    const claude = new ClaudeAdapter(state);
    await codex.applyBindings(
      await codex.planBindings(state.environment),
      machineId,
    );
    await claude.applyBindings(
      await claude.planBindings(state.environment),
      machineId,
    );
    const registry = await readBindingRegistry({
      stackHome: state.stackHome,
      machineId,
    });
    expect(registry.bindings.map((item) => item.targetRoot).sort()).toEqual([
      'agents',
      'claude',
    ]);
    const agentsTarget = path.join(state.homeDir, '.agents', 'skills', 'foo');
    const claudeTarget = path.join(state.homeDir, '.claude', 'skills', 'foo');

    // The shared family (Cursor here) removes only its own 'agents' root — the
    // Claude physical binding and its ownership record survive untouched.
    const cursor = new CursorAdapter(state);
    const cursorRemoval = await cursor.removeBindings({
      machineId,
      environmentEntryIds: ['skill_12345678'],
    });
    expect(cursorRemoval.removed.map((item) => item.targetRoot)).toEqual([
      'agents',
    ]);
    await expect(stat(agentsTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(claudeTarget)).toBeDefined();
    expect(
      (
        await readBindingRegistry({ stackHome: state.stackHome, machineId })
      ).bindings.map((item) => item.targetRoot),
    ).toEqual(['claude']);

    // Conversely, Claude reconciling an empty environment removes only its own
    // 'claude' root and can never reach the (already-removed) shared root.
    const claudeReduced = await claude.planBindings({
      ...state.environment,
      skills: [],
    });
    expect(claudeReduced.operations).toMatchObject([
      { state: 'remove-managed', stale: true },
    ]);
    await claude.applyBindings(claudeReduced, machineId);
    await expect(stat(claudeTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readBindingRegistry({ stackHome: state.stackHome, machineId }))
        .bindings,
    ).toEqual([]);
  });

  it('persists the registry atomically under the machine-scoped path', async () => {
    const state = await setup();
    const codex = new CodexAdapter(state);
    await codex.applyBindings(
      await codex.planBindings(state.environment),
      machineId,
    );
    const registryFile = path.join(
      state.stackHome,
      'state',
      'machines',
      machineId,
      'bindings.json',
    );
    expect(await stat(registryFile)).toBeDefined();
    // No temp files are left behind after an atomic write.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.dirname(registryFile));
    expect(entries).toEqual(['bindings.json']);
  });
});

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
import type { ResolvedLocalEnvironment } from '@stack/spec';
import { ingestSkill } from '@stack/store';

import { CursorAdapter, detectCursor } from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-cursor-'));
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

describe('Cursor detection', () => {
  it('prefers a validated `agent` executable when it is genuine', async () => {
    const calls: string[] = [];
    const result = await detectCursor({
      findExecutable: async (name) =>
        ({ agent: '/bin/agent', 'cursor-agent': '/bin/cursor-agent' })[name],
      runVersion: async (file) => {
        calls.push(file);
        return 'Cursor Agent CLI 1.4.2';
      },
    });
    expect(calls).toEqual(['/bin/agent']);
    expect(result).toMatchObject({
      agent: 'cursor',
      installed: true,
      executablePath: '/bin/agent',
    });
  });

  it('rejects an unrelated `agent` and falls back to cursor-agent', async () => {
    const calls: string[] = [];
    const result = await detectCursor({
      findExecutable: async (name) =>
        ({ agent: '/bin/agent', 'cursor-agent': '/bin/cursor-agent' })[name],
      runVersion: async (file) => {
        calls.push(file);
        return file.endsWith('cursor-agent')
          ? 'cursor-agent 2.0'
          : 'coolagent 9.9';
      },
    });
    expect(calls).toEqual(['/bin/agent', '/bin/cursor-agent']);
    expect(result.executablePath).toBe('/bin/cursor-agent');
  });

  it('reports Cursor missing when no candidate resolves', async () => {
    const result = await detectCursor({
      findExecutable: async () => undefined,
    });
    expect(result).toEqual({ agent: 'cursor', installed: false });
  });

  it('rejects `agent` when its version output cannot be read', async () => {
    const result = await detectCursor({
      findExecutable: async (name) =>
        name === 'agent' ? '/bin/agent' : undefined,
      runVersion: async () => undefined,
    });
    expect(result).toEqual({ agent: 'cursor', installed: false });
  });
});

describe('Cursor write-root privacy', () => {
  it('writes only to the shared ~/.agents/skills root and never to ~/.cursor/skills', async () => {
    const state = await setup();
    const cursor = new CursorAdapter(state);
    const plan = await cursor.planBindings(state.environment);
    expect(plan.targetRoot).toBe(path.join(state.homeDir, '.agents', 'skills'));
    await cursor.applyBindings(plan, machineId);
    expect(
      (
        await hashSkillDirectory(
          path.join(state.homeDir, '.agents', 'skills', 'foo'),
        )
      ).hash,
    ).toBe(state.contentHash);
    await expect(
      stat(path.join(state.homeDir, '.cursor', 'skills', 'foo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the write root anchored to HOME and independent of STACK_HOME', async () => {
    const root = await temp();
    const homeDir = path.join(root, 'home');
    const cursorFar = new CursorAdapter({
      stackHome: path.join(root, 'far-away-stack-home'),
      homeDir,
    });
    const plan = await cursorFar.planBindings({
      name: 'main',
      machineId,
      skills: [],
    });
    expect(plan.targetRoot).toBe(path.join(homeDir, '.agents', 'skills'));
  });

  it('never mutates compatibility roots when applying a shared binding', async () => {
    const state = await setup();
    const cursorRoot = path.join(state.homeDir, '.cursor', 'skills', 'keep');
    const claudeRoot = path.join(state.homeDir, '.claude', 'skills', 'keep');
    const codexRoot = path.join(state.homeDir, '.codex', 'skills', 'keep');
    for (const compat of [cursorRoot, claudeRoot, codexRoot])
      await makeSkill(compat, 'keep', 'compat sentinel');
    const before = await Promise.all(
      [cursorRoot, claudeRoot, codexRoot].map((compat) =>
        readFile(path.join(compat, 'SKILL.md'), 'utf8'),
      ),
    );
    const cursor = new CursorAdapter(state);
    await cursor.applyBindings(
      await cursor.planBindings(state.environment),
      machineId,
    );
    const after = await Promise.all(
      [cursorRoot, claudeRoot, codexRoot].map((compat) =>
        readFile(path.join(compat, 'SKILL.md'), 'utf8'),
      ),
    );
    expect(after).toEqual(before);
  });

  it('blocks --yes style application while a visibility conflict is unresolved', async () => {
    const state = await setup();
    await makeSkill(
      path.join(state.homeDir, '.claude', 'skills', 'foo'),
      'foo',
      'different bytes',
    );
    const cursor = new CursorAdapter(state);
    const plan = await cursor.planBindings(state.environment);
    expect(plan.operations[0]?.state).toBe('visibility-conflict');
    expect(plan.blocking).toBe(true);
    // Even a forced apply must refuse a blocking plan.
    await expect(cursor.applyBindings(plan, machineId)).rejects.toThrow();
  });
});

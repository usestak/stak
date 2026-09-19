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

import {
  BindingApplyFailedError,
  BindingConflictError,
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  type CodexAdapterOptions,
  type SpawnProcess,
} from './index.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-conformance-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const makeStored = async (stackHome: string, name: string, body: string) => {
  const source = path.join(await temp(), name);
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
  );
  const contentHash = (await hashSkillDirectory(source)).hash;
  await ingestSkill({
    stackHome,
    sourcePath: source,
    expectedContentHash: contentHash,
  });
  return contentHash;
};

const machineId = '00000000-0000-4000-8000-000000000000';
const asEnvironment = (
  skills: ResolvedLocalEnvironment['skills'],
): ResolvedLocalEnvironment => ({ name: 'main', machineId, skills });

type AdapterCase = {
  id: 'codex' | 'cursor' | 'claude';
  create: (options: CodexAdapterOptions) => CodexAdapter;
  rootKind: 'agents' | 'claude';
};

const cases: AdapterCase[] = [
  { id: 'codex', create: (o) => new CodexAdapter(o), rootKind: 'agents' },
  { id: 'cursor', create: (o) => new CursorAdapter(o), rootKind: 'agents' },
  { id: 'claude', create: (o) => new ClaudeAdapter(o), rootKind: 'claude' },
];

const bindingRootDir = (homeDir: string, rootKind: 'agents' | 'claude') =>
  path.join(homeDir, rootKind === 'claude' ? '.claude' : '.agents', 'skills');

describe.each(cases)(
  'filesystem adapter conformance ($id)',
  ({ id, create, rootKind }) => {
    const base = async () => {
      const root = await temp();
      const stackHome = path.join(root, 'stack');
      const homeDir = path.join(root, 'home');
      return { root, stackHome, homeDir };
    };

    it('materializes exact stored bytes and records physical ownership', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const adapter = create({ stackHome, homeDir });
      const environment = asEnvironment([
        { entryId: 'skill_12345678', name: 'demo', contentHash },
      ]);
      const plan = await adapter.planBindings(environment);
      expect(plan.operations[0]?.state).toBe('add');
      expect(plan.targetRoot).toBe(bindingRootDir(homeDir, rootKind));
      await adapter.applyBindings(plan, machineId);
      const target = path.join(bindingRootDir(homeDir, rootKind), 'demo');
      expect((await hashSkillDirectory(target)).hash).toBe(contentHash);
      expect(
        (await adapter.planBindings(environment)).operations[0]?.state,
      ).toBe('already-managed');
    });

    it('protects differing unmanaged targets from mutation', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const target = path.join(bindingRootDir(homeDir, rootKind), 'demo');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'SKILL.md'), 'unmanaged bytes');
      const before = await readFile(path.join(target, 'SKILL.md'), 'utf8');
      const adapter = create({ stackHome, homeDir });
      const plan = await adapter.planBindings(
        asEnvironment([
          { entryId: 'skill_12345678', name: 'demo', contentHash },
        ]),
      );
      expect(plan.operations[0]?.state).toBe('conflict-unmanaged');
      expect(plan.blocking).toBe(true);
      await expect(
        adapter.applyBindings(plan, machineId),
      ).rejects.toBeInstanceOf(BindingConflictError);
      expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(
        before,
      );
    });

    it('treats an exact unmanaged copy as externally satisfied without ownership', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const target = path.join(bindingRootDir(homeDir, rootKind), 'demo');
      await mkdir(path.dirname(target), { recursive: true });
      await materializeStoredSkill({
        stackHome,
        contentHash,
        targetPath: target,
      });
      const adapter = create({ stackHome, homeDir });
      const plan = await adapter.planBindings(
        asEnvironment([
          { entryId: 'skill_12345678', name: 'demo', contentHash },
        ]),
      );
      expect(plan.operations[0]?.state).toBe('externally-satisfied');
      expect(plan.blocking).toBe(false);
    });

    it('repairs a drifted still-desired managed binding as managed-drift', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const adapter = create({ stackHome, homeDir });
      const environment = asEnvironment([
        { entryId: 'skill_12345678', name: 'demo', contentHash },
      ]);
      await adapter.applyBindings(
        await adapter.planBindings(environment),
        machineId,
      );
      const target = path.join(bindingRootDir(homeDir, rootKind), 'demo');
      await writeFile(path.join(target, 'SKILL.md'), 'drifted');
      const plan = await adapter.planBindings(environment);
      expect(plan.operations[0]?.state).toBe('managed-drift');
      expect(plan.operations[0]?.stale).toBeUndefined();
      expect(plan.blocking).toBe(false);
      await adapter.applyBindings(plan, machineId);
      expect((await hashSkillDirectory(target)).hash).toBe(contentHash);
    });

    it('removes a healthy stale managed binding and refuses a modified one', async () => {
      const { stackHome, homeDir } = await base();
      const healthy = await makeStored(stackHome, 'healthy', 'a');
      const modified = await makeStored(stackHome, 'modified', 'b');
      const adapter = create({ stackHome, homeDir });
      const full = asEnvironment([
        { entryId: 'skill_healthy0', name: 'healthy', contentHash: healthy },
        { entryId: 'skill_modified0', name: 'modified', contentHash: modified },
      ]);
      await adapter.applyBindings(await adapter.planBindings(full), machineId);
      const modifiedTarget = path.join(
        bindingRootDir(homeDir, rootKind),
        'modified',
      );
      await writeFile(path.join(modifiedTarget, 'SKILL.md'), 'user edit');
      const reduced = await adapter.planBindings(asEnvironment([]));
      const modifiedOp = reduced.operations.find(
        (item) => item.skillName === 'modified',
      );
      const healthyOp = reduced.operations.find(
        (item) => item.skillName === 'healthy',
      );
      expect(modifiedOp).toMatchObject({ state: 'managed-drift', stale: true });
      expect(healthyOp).toMatchObject({ state: 'remove-managed', stale: true });
      expect(reduced.blocking).toBe(true);
      await expect(
        adapter.applyBindings(reduced, machineId),
      ).rejects.toBeInstanceOf(BindingConflictError);
      // The modified binding is preserved because the plan is blocking.
      expect(await stat(modifiedTarget)).toBeDefined();
    });

    it('rolls back created targets when registry persistence fails', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const adapter = create({
        stackHome,
        homeDir,
        writeRegistry: async () => {
          throw new Error('registry denied');
        },
      });
      const environment = asEnvironment([
        { entryId: 'skill_12345678', name: 'demo', contentHash },
      ]);
      await expect(
        adapter.applyBindings(
          await adapter.planBindings(environment),
          machineId,
        ),
      ).rejects.toBeInstanceOf(BindingApplyFailedError);
      await expect(
        stat(path.join(bindingRootDir(homeDir, rootKind), 'demo')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('classifies missing and corrupt Store content before mutation', async () => {
      const { stackHome, homeDir } = await base();
      const adapter = create({ stackHome, homeDir });
      const missing = `sha256:${'a'.repeat(64)}`;
      const missingPlan = await adapter.planBindings(
        asEnvironment([
          { entryId: 'skill_12345678', name: 'missing', contentHash: missing },
        ]),
      );
      expect(missingPlan.operations[0]?.state).toBe('store-unavailable');
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      await writeFile(
        path.join(
          stackHome,
          'store',
          'sha256',
          contentHash.slice(7, 9),
          contentHash.slice(7),
          'content',
          'SKILL.md',
        ),
        'corrupted',
      );
      const corruptPlan = await adapter.planBindings(
        asEnvironment([
          { entryId: 'skill_abcdefgh', name: 'demo', contentHash },
        ]),
      );
      expect(corruptPlan.operations[0]?.state).toBe('store-corrupt');
    });

    it('keeps a dry-run plan free of filesystem mutation', async () => {
      const { stackHome, homeDir } = await base();
      const contentHash = await makeStored(stackHome, 'demo', 'desired');
      const adapter = create({ stackHome, homeDir });
      await adapter.planBindings(
        asEnvironment([
          { entryId: 'skill_12345678', name: 'demo', contentHash },
        ]),
      );
      await expect(
        stat(bindingRootDir(homeDir, rootKind)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('launches with shell:false, inherited stdio, preserved cwd/env, and exit status', async () => {
      const { stackHome, homeDir } = await base();
      const calls: Array<{
        file: string;
        options: Parameters<SpawnProcess>[2];
      }> = [];
      const detection: AgentDetection = {
        agent: id,
        installed: true,
        executablePath: `/bin/${id}`,
      };
      const preservedEnv = {
        HOME: '/real/home',
        USERPROFILE: 'C:/Users/real',
        CLAUDE_CONFIG_DIR: '/cfg/claude',
        CURSOR_CONFIG_DIR: '/cfg/cursor',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://example',
      };
      const adapter = create({
        stackHome,
        homeDir,
        detect: async () => detection,
        spawnProcess: async (file, args, options) => {
          calls.push({ file, options });
          expect(args).toEqual([]);
          return { exitCode: 42, signal: null };
        },
      });
      const result = await adapter.launch({
        cwd: '/work/dir',
        env: preservedEnv,
      });
      expect(result).toMatchObject({ agent: id, exitCode: 42 });
      expect(calls[0]?.file).toBe(`/bin/${id}`);
      expect(calls[0]?.options).toMatchObject({
        cwd: '/work/dir',
        shell: false,
        stdio: 'inherit',
        env: preservedEnv,
      });
    });
  },
);

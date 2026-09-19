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

import {
  AgentNotInstalledError,
  BindingApplyFailedError,
  BindingConflictError,
  CodexAdapter,
  bindingRegistryPath,
  detectCodex,
  launchCodex,
  readBindingRegistry,
  resolveCodexBindingRoot,
} from './index.js';

const temporaryDirectories: string[] = [];
const temp = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'stack-codex-'));
  temporaryDirectories.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});

const createStoredSkill = async (
  stackHome: string,
  name: string,
  body = 'one',
) => {
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
  return { source, contentHash };
};
const environment = (
  machineId: string,
  skills: ResolvedLocalEnvironment['skills'],
): ResolvedLocalEnvironment => ({ name: 'main', machineId, skills });

describe('Codex adapter', () => {
  it('uses HOME/.agents/skills independently from STACK_HOME', () => {
    expect(
      resolveCodexBindingRoot({
        homeDir: '/home/alex',
        stackHome: '/elsewhere',
      }),
    ).toBe(path.resolve('/home/alex', '.agents', 'skills'));
  });

  it('detects Codex through injected direct executable lookup', async () => {
    const result = await detectCodex({
      findExecutable: async () => '/bin/codex',
      runVersion: async (file, args) => {
        expect(file).toBe('/bin/codex');
        expect(args).toEqual(['--version']);
        return 'codex-cli 1.2.3';
      },
    });
    expect(result).toMatchObject({
      installed: true,
      executablePath: '/bin/codex',
      version: 'codex-cli 1.2.3',
    });
  });

  it('reports missing Codex without throwing', async () => {
    expect(
      await detectCodex({ findExecutable: async () => undefined }),
    ).toEqual({ agent: 'codex', installed: false });
  });

  it('keeps Codex installed when the optional version probe fails', async () => {
    const result = await detectCodex({
      findExecutable: async () => 'C:/bin/codex.exe',
      runVersion: async () => {
        throw new Error('spawn failed');
      },
    });

    expect(result).toEqual({
      agent: 'codex',
      installed: true,
      executablePath: 'C:/bin/codex.exe',
    });
  });

  it('plans additions and applies exact stored bytes with ownership recorded afterward', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);

    const plan = await adapter.planBindings(desired);
    expect(plan.operations[0]?.state).toBe('add');
    await adapter.applyBindings(plan, desired.machineId);

    const target = path.join(homeDir, '.agents', 'skills', 'demo');
    expect((await hashSkillDirectory(target)).hash).toBe(stored.contentHash);
    expect(
      (
        await readBindingRegistry({
          stackHome,
          machineId: desired.machineId,
          targetRoot: path.dirname(target),
        })
      ).bindings,
    ).toHaveLength(1);
    expect((await adapter.planBindings(desired)).operations[0]?.state).toBe(
      'already-managed',
    );
  });

  it('leaves identical unmanaged content externally satisfied and unclaimed', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const target = path.join(homeDir, '.agents', 'skills', 'demo');
    await mkdir(path.dirname(target), { recursive: true });
    const { cp } = await import('node:fs/promises');
    await cp(stored.source, target, { recursive: true });
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);
    expect((await adapter.planBindings(desired)).operations[0]?.state).toBe(
      'externally-satisfied',
    );
    expect(
      (
        await readBindingRegistry({
          stackHome,
          machineId: desired.machineId,
          targetRoot: path.dirname(target),
        })
      ).bindings,
    ).toEqual([]);
  });

  it('allows an identical unmanaged target to satisfy Codex even when Store content is absent', async () => {
    const root = await temp();
    const homeDir = path.join(root, 'home');
    const source = path.join(homeDir, '.agents', 'skills', 'demo');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), 'external exact bytes');
    const contentHash = (await hashSkillDirectory(source)).hash;
    const adapter = new CodexAdapter({
      stackHome: path.join(root, 'empty-stack'),
      homeDir,
    });

    const plan = await adapter.planBindings(
      environment('00000000-0000-4000-8000-000000000000', [
        { entryId: 'skill_12345678', name: 'demo', contentHash },
      ]),
    );

    expect(plan.operations[0]?.state).toBe('externally-satisfied');
    expect(plan.blocking).toBe(false);
  });

  it('blocks differing unmanaged content and never overwrites it', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const target = path.join(homeDir, '.agents', 'skills', 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'SKILL.md'), 'unmanaged');
    const before = await readFile(path.join(target, 'SKILL.md'), 'utf8');
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);
    const plan = await adapter.planBindings(desired);
    expect(plan.operations[0]?.state).toBe('conflict-unmanaged');
    await expect(
      adapter.applyBindings(plan, desired.machineId),
    ).rejects.toBeInstanceOf(BindingConflictError);
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(before);
  });

  it.each(['../demo', 'foo/bar', 'C:\\demo', '.', 'CON'])(
    'rejects unsafe target name %s',
    async (name) => {
      const root = await temp();
      const adapter = new CodexAdapter({
        stackHome: path.join(root, 'stack'),
        homeDir: path.join(root, 'home'),
      });
      const desired = environment('00000000-0000-4000-8000-000000000000', [
        {
          entryId: 'skill_12345678',
          name,
          contentHash: `sha256:${'a'.repeat(64)}`,
        },
      ]);
      expect((await adapter.planBindings(desired)).operations[0]?.state).toBe(
        'invalid-target-name',
      );
    },
  );

  it('blocks same-name desired collisions', async () => {
    const root = await temp();
    const stored = await createStoredSkill(path.join(root, 'stack'), 'demo');
    const adapter = new CodexAdapter({
      stackHome: path.join(root, 'stack'),
      homeDir: path.join(root, 'home'),
    });
    const plan = await adapter.planBindings(
      environment('00000000-0000-4000-8000-000000000000', [
        {
          entryId: 'skill_12345678',
          name: 'demo',
          contentHash: stored.contentHash,
        },
        {
          entryId: 'skill_abcdefgh',
          name: 'demo',
          contentHash: `sha256:${'b'.repeat(64)}`,
        },
      ]),
    );
    expect(
      plan.operations.every((item) => item.state === 'conflict-name'),
    ).toBe(true);
  });

  it('classifies unavailable and corrupt store content before binding', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const adapter = new CodexAdapter({
      stackHome,
      homeDir: path.join(root, 'home'),
    });
    const missing = `sha256:${'a'.repeat(64)}`;
    const missingPlan = await adapter.planBindings(
      environment('00000000-0000-4000-8000-000000000000', [
        { entryId: 'skill_12345678', name: 'missing', contentHash: missing },
      ]),
    );
    expect(missingPlan.operations[0]?.state).toBe('store-unavailable');
    const stored = await createStoredSkill(stackHome, 'demo');
    const object = path.join(
      stackHome,
      'store',
      'sha256',
      stored.contentHash.slice(7, 9),
      stored.contentHash.slice(7),
      'content',
      'SKILL.md',
    );
    await writeFile(object, 'corrupt');
    const corruptPlan = await adapter.planBindings(
      environment('00000000-0000-4000-8000-000000000000', [
        {
          entryId: 'skill_abcdefgh',
          name: 'demo',
          contentHash: stored.contentHash,
        },
      ]),
    );
    expect(corruptPlan.operations[0]?.state).toBe('store-corrupt');
  });

  it('detects externally modified managed content and refuses removal', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);
    await adapter.applyBindings(
      await adapter.planBindings(desired),
      desired.machineId,
    );
    const target = path.join(homeDir, '.agents', 'skills', 'demo');
    await writeFile(path.join(target, 'SKILL.md'), 'changed');
    expect((await adapter.planBindings(desired)).operations[0]?.state).toBe(
      'managed-drift',
    );
    await expect(
      adapter.removeBindings({
        machineId: desired.machineId,
        environmentEntryIds: ['skill_12345678'],
      }),
    ).rejects.toBeInstanceOf(BindingConflictError);
    expect(await stat(target)).toBeDefined();
  });

  it('removes only healthy Stack-owned content and verifies missing/changed bindings', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const adapter = new CodexAdapter({ stackHome, homeDir });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);
    await adapter.applyBindings(
      await adapter.planBindings(desired),
      desired.machineId,
    );
    expect((await adapter.verifyBindings(desired)).healthy).toBe(true);
    const result = await adapter.removeBindings({
      machineId: desired.machineId,
      environmentEntryIds: ['skill_12345678'],
    });
    expect(result.removed).toHaveLength(1);
    expect((await adapter.verifyBindings(desired)).bindings).toEqual([]);
  });

  it.each([
    ['missing', async (target: string) => rm(target, { recursive: true })],
    [
      'changed',
      async (target: string) =>
        writeFile(path.join(target, 'SKILL.md'), 'changed'),
    ],
  ] as const)(
    'verification reports a %s managed target',
    async (state, mutate) => {
      const root = await temp();
      const stackHome = path.join(root, 'stack');
      const homeDir = path.join(root, 'home');
      const stored = await createStoredSkill(stackHome, 'demo');
      const adapter = new CodexAdapter({ stackHome, homeDir });
      const desired = environment('00000000-0000-4000-8000-000000000000', [
        {
          entryId: 'skill_12345678',
          name: 'demo',
          contentHash: stored.contentHash,
        },
      ]);
      await adapter.applyBindings(
        await adapter.planBindings(desired),
        desired.machineId,
      );
      await mutate(path.join(homeDir, '.agents', 'skills', 'demo'));

      const verification = await adapter.verifyBindings(desired);

      expect(verification.healthy).toBe(false);
      expect(verification.bindings[0]?.state).toBe(state);
    },
  );

  it('rolls back created targets if registry persistence fails', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const stored = await createStoredSkill(stackHome, 'demo');
    const adapter = new CodexAdapter({
      stackHome,
      homeDir,
      writeRegistry: async () => {
        throw new Error('registry denied');
      },
    });
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: stored.contentHash,
      },
    ]);
    await expect(
      adapter.applyBindings(
        await adapter.planBindings(desired),
        desired.machineId,
      ),
    ).rejects.toBeInstanceOf(BindingApplyFailedError);
    await expect(
      stat(path.join(homeDir, '.agents', 'skills', 'demo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies multiple additions and rolls all additions back on a later failure', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const first = await createStoredSkill(stackHome, 'first');
    const second = await createStoredSkill(stackHome, 'second');
    const desired = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'first',
        contentHash: first.contentHash,
      },
      {
        entryId: 'skill_abcdefgh',
        name: 'second',
        contentHash: second.contentHash,
      },
    ]);
    const successful = new CodexAdapter({ stackHome, homeDir });
    expect(
      (
        await successful.applyBindings(
          await successful.planBindings(desired),
          desired.machineId,
        )
      ).applied,
    ).toHaveLength(2);
    await successful.removeBindings({
      machineId: desired.machineId,
      environmentEntryIds: desired.skills.map((item) => item.entryId),
    });

    let calls = 0;
    const failing = new CodexAdapter({
      stackHome,
      homeDir,
      materialize: async (options) => {
        calls += 1;
        if (calls === 2) throw new Error('second failed');
        const { materializeStoredSkill } = await import('@stack/store');
        return materializeStoredSkill(options);
      },
    });
    await expect(
      failing.applyBindings(
        await failing.planBindings(desired),
        desired.machineId,
      ),
    ).rejects.toBeInstanceOf(BindingApplyFailedError);
    for (const name of ['first', 'second'])
      await expect(
        stat(path.join(homeDir, '.agents', 'skills', name)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('updates a healthy managed binding and restores it if the update fails', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const homeDir = path.join(root, 'home');
    const oldSkill = await createStoredSkill(stackHome, 'demo', 'old');
    const newSkill = await createStoredSkill(stackHome, 'demo', 'new');
    const oldEnvironment = environment('00000000-0000-4000-8000-000000000000', [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: oldSkill.contentHash,
      },
    ]);
    const newEnvironment = environment(oldEnvironment.machineId, [
      {
        entryId: 'skill_12345678',
        name: 'demo',
        contentHash: newSkill.contentHash,
      },
    ]);
    const adapter = new CodexAdapter({ stackHome, homeDir });
    await adapter.applyBindings(
      await adapter.planBindings(oldEnvironment),
      oldEnvironment.machineId,
    );
    expect(
      (await adapter.planBindings(newEnvironment)).operations[0]?.state,
    ).toBe('update-managed');

    const failing = new CodexAdapter({
      stackHome,
      homeDir,
      materialize: async () => {
        throw new Error('copy failed');
      },
    });
    await expect(
      failing.applyBindings(
        await failing.planBindings(newEnvironment),
        newEnvironment.machineId,
      ),
    ).rejects.toBeInstanceOf(BindingApplyFailedError);
    expect(
      (
        await hashSkillDirectory(
          path.join(homeDir, '.agents', 'skills', 'demo'),
        )
      ).hash,
    ).toBe(oldSkill.contentHash);

    await adapter.applyBindings(
      await adapter.planBindings(newEnvironment),
      newEnvironment.machineId,
    );
    expect(
      (
        await hashSkillDirectory(
          path.join(homeDir, '.agents', 'skills', 'demo'),
        )
      ).hash,
    ).toBe(newSkill.contentHash);
  });

  it('refuses a removal request for an unregistered entry', async () => {
    const root = await temp();
    const adapter = new CodexAdapter({
      stackHome: path.join(root, 'stack'),
      homeDir: path.join(root, 'home'),
    });
    await expect(
      adapter.removeBindings({
        machineId: '00000000-0000-4000-8000-000000000000',
        environmentEntryIds: ['skill_12345678'],
      }),
    ).rejects.toBeInstanceOf(BindingConflictError);
  });

  it('launches directly with inherited environment, requested cwd, shell false, and exit status', async () => {
    const calls: unknown[] = [];
    const result = await launchCodex({
      detection: {
        agent: 'codex',
        installed: true,
        executablePath: '/bin/codex',
      },
      cwd: '/workspace',
      env: { HOME: '/real-home', TOKEN: 'kept' },
      spawnProcess: async (file, args, options) => {
        calls.push({ file, args, options });
        return { exitCode: 7, signal: null };
      },
    });
    expect(calls[0]).toMatchObject({
      file: '/bin/codex',
      args: [],
      options: {
        cwd: '/workspace',
        shell: false,
        stdio: 'inherit',
        env: { HOME: '/real-home', TOKEN: 'kept' },
      },
    });
    expect(result.exitCode).toBe(7);
  });

  it('refuses launch when Codex is absent', async () => {
    await expect(
      launchCodex({ detection: { agent: 'codex', installed: false } }),
    ).rejects.toBeInstanceOf(AgentNotInstalledError);
  });

  it('uses the machine-specific registry location', () => {
    expect(bindingRegistryPath('/stack', 'machine')).toBe(
      path.resolve(
        '/stack',
        'state',
        'machines',
        'machine',
        'bindings',
        'codex.json',
      ),
    );
  });
});

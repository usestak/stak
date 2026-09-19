import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashSkillDirectory, pathsEqual } from '@stack/shared';
import {
  agentDetectionSchema,
  bindingApplyResultSchema,
  bindingPlanSchema,
  bindingRegistrySchema,
  bindingVerificationSchema,
  launchResultSchema,
} from '@stack/spec';
import type {
  AgentId,
  AgentDetection,
  BindingApplyResult,
  BindingOperation,
  BindingPlan,
  BindingRecord,
  BindingRegistry,
  BindingVerification,
  LaunchResult,
  ResolvedLocalEnvironment,
} from '@stack/spec';
import { materializeStoredSkill, verifyStoredSkill } from '@stack/store';
import {
  AgentLaunchFailedError,
  AgentNotInstalledError,
  BindingApplyFailedError,
  BindingConflictError,
  BindingRegistryCorruptError,
  BindingRollbackFailedError,
} from './errors.js';
import type {
  AgentAdapter,
  BindingRemovalRequest,
  LaunchContext,
} from './types.js';

const exists = async (value: string) => {
  try {
    await access(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
export const resolveCodexBindingRoot = (options: {
  homeDir?: string;
  stackHome?: string;
}) => path.resolve(options.homeDir ?? os.homedir(), '.agents', 'skills');
export const bindingRegistryPath = (stackHome: string, machineId: string) =>
  path.resolve(stackHome, 'state', 'machines', machineId, 'bindings.json');
export type WriteRegistry = (
  file: string,
  registry: BindingRegistry,
) => Promise<void>;
export const writeBindingRegistry: WriteRegistry = async (file, registry) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(bindingRegistrySchema.parse(registry), null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};
export const readBindingRegistry = async (options: {
  stackHome: string;
  machineId: string;
  targetRoot?: string;
}): Promise<BindingRegistry> => {
  const file = bindingRegistryPath(options.stackHome, options.machineId);
  try {
    const registry = bindingRegistrySchema.parse(
      JSON.parse(await readFile(file, 'utf8')),
    );
    if (registry.machineId !== options.machineId)
      throw new BindingRegistryCorruptError(
        'Binding registry Machine identity does not match this Machine.',
      );
    return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return bindingRegistrySchema.parse({
        schemaVersion: 1,
        machineId: options.machineId,
        bindings: [],
      });
    if (error instanceof BindingRegistryCorruptError) throw error;
    throw new BindingRegistryCorruptError(
      'Codex binding registry is malformed.',
      { cause: error },
    );
  }
};

const executableExtensions = () =>
  process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
export const findExecutableOnPath = async (
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> => {
  for (const directory of (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean))
    for (const extension of executableExtensions()) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  return undefined;
};
const directVersion = async (
  file: string,
  args: string[],
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 3000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output.trim() || undefined);
    });
  });
export const detectExecutableAgent = async (options: {
  agent: AgentId;
  candidates: string[];
  validateVersion?: (version: string, candidate: string) => boolean;
  env?: NodeJS.ProcessEnv;
  findExecutable?: typeof findExecutableOnPath;
  runVersion?: (file: string, args: string[]) => Promise<string | undefined>;
}): Promise<AgentDetection> => {
  for (const candidate of options.candidates) {
    const executablePath = await (
      options.findExecutable ?? findExecutableOnPath
    )(candidate, options.env);
    if (!executablePath) continue;
    const version = await (options.runVersion ?? directVersion)(
      executablePath,
      ['--version'],
    ).catch(() => undefined);
    if (
      options.validateVersion &&
      (!version || !options.validateVersion(version, candidate))
    )
      continue;
    return agentDetectionSchema.parse({
      agent: options.agent,
      installed: true,
      executablePath,
      ...(version ? { version } : {}),
    });
  }
  return agentDetectionSchema.parse({ agent: options.agent, installed: false });
};
export const detectCodex = async (
  options: {
    env?: NodeJS.ProcessEnv;
    findExecutable?: (
      name: string,
      env?: NodeJS.ProcessEnv,
    ) => Promise<string | undefined>;
    runVersion?: (file: string, args: string[]) => Promise<string | undefined>;
  } = {},
): Promise<AgentDetection> => {
  const executablePath = await (options.findExecutable ?? findExecutableOnPath)(
    'codex',
    options.env,
  );
  if (!executablePath)
    return agentDetectionSchema.parse({ agent: 'codex', installed: false });
  const version = await (options.runVersion ?? directVersion)(executablePath, [
    '--version',
  ]).catch(() => undefined);
  return agentDetectionSchema.parse({
    agent: 'codex',
    installed: true,
    executablePath,
    ...(version ? { version } : {}),
  });
};

const invalidBindingName = (name: string) =>
  !name ||
  name === '.' ||
  name === '..' ||
  name.includes('/') ||
  name.includes('\\') ||
  path.isAbsolute(name) ||
  /[<>:"|?*]/.test(name) ||
  [...name].some((character) => character.charCodeAt(0) <= 31) ||
  /[. ]$/.test(name) ||
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name);
export const isSafeCodexSkillName = (name: string) => !invalidBindingName(name);
const currentHash = async (target: string): Promise<string | undefined> =>
  (await exists(target)) ? (await hashSkillDirectory(target)).hash : undefined;
const blockedStates = new Set([
  'conflict-unmanaged',
  'conflict-name',
  'invalid-target-name',
  'store-unavailable',
  'store-corrupt',
  'visibility-conflict',
]);
export type SpawnProcess = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: 'inherit';
  },
) => Promise<{ exitCode: number | null; signal?: string | null }>;
export type CodexAdapterOptions = {
  stackHome: string;
  homeDir?: string;
  now?: () => Date;
  writeRegistry?: WriteRegistry;
  materialize?: typeof materializeStoredSkill;
  detection?: Parameters<typeof detectCodex>[0];
  spawnProcess?: SpawnProcess;
  agent?: AgentId;
  targetRootKind?: 'agents' | 'claude';
  visibilityRoots?: string[];
  detect?: () => Promise<AgentDetection>;
};

export class FilesystemSkillAdapter implements AgentAdapter {
  readonly id: AgentId;
  private readonly targetRoot: string;
  constructor(private readonly options: CodexAdapterOptions) {
    this.id = options.agent ?? 'codex';
    this.targetRoot = path.resolve(
      options.homeDir ?? os.homedir(),
      options.targetRootKind === 'claude' ? '.claude' : '.agents',
      'skills',
    );
  }
  detect() {
    return this.options.detect?.() ?? detectCodex(this.options.detection);
  }
  async planBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingPlan> {
    const registry = await readBindingRegistry({
      stackHome: this.options.stackHome,
      machineId: environment.machineId,
    });
    const counts = new Map<string, number>();
    for (const skill of environment.skills)
      counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    const operations: BindingOperation[] = await Promise.all(
      environment.skills.map(async (skill) => {
        const targetPath = path.join(this.targetRoot, skill.name);
        const base = {
          entryId: skill.entryId,
          skillName: skill.name,
          contentHash: skill.contentHash,
          targetPath,
        };
        if (invalidBindingName(skill.name))
          return { ...base, state: 'invalid-target-name' as const };
        if ((counts.get(skill.name) ?? 0) > 1)
          return { ...base, state: 'conflict-name' as const };
        if (this.id === 'cursor') {
          const visible = (
            await Promise.all(
              (this.options.visibilityRoots ?? []).map(async (root) => ({
                path: path.join(root, skill.name),
                hash: await currentHash(path.join(root, skill.name)),
              })),
            )
          ).filter((item) => item.path !== targetPath);
          const present = visible.filter(
            (item): item is { path: string; hash: string } =>
              Boolean(item.hash),
          );
          if (present.some((item) => item.hash !== skill.contentHash))
            return {
              ...base,
              state: 'visibility-conflict' as const,
              message: present
                .map((item) => `${item.path} (${item.hash})`)
                .join(', '),
            };
          if (
            !(await currentHash(targetPath)) &&
            present.some((item) => item.hash === skill.contentHash)
          )
            return {
              ...base,
              state: 'externally-satisfied' as const,
              currentHash: skill.contentHash,
            };
        }
        const hash = await currentHash(targetPath);
        let record: BindingRecord | undefined;
        for (const item of registry.bindings)
          if (
            item.environmentEntryId === skill.entryId &&
            (await pathsEqual({ left: item.targetPath, right: targetPath }))
          ) {
            record = item;
            break;
          }
        if (!record && hash)
          return hash === skill.contentHash
            ? {
                ...base,
                state: 'externally-satisfied' as const,
                currentHash: hash,
              }
            : {
                ...base,
                state: 'conflict-unmanaged' as const,
                currentHash: hash,
              };
        if (
          record &&
          hash === record.contentHash &&
          record.contentHash === skill.contentHash
        )
          return {
            ...base,
            state: 'already-managed' as const,
            currentHash: hash,
            installedHash: record.contentHash,
          };
        const preservation = await verifyStoredSkill({
          stackHome: this.options.stackHome,
          contentHash: skill.contentHash,
        });
        if (preservation.state === 'missing')
          return { ...base, state: 'store-unavailable' as const, preservation };
        if (preservation.state === 'corrupt')
          return { ...base, state: 'store-corrupt' as const, preservation };
        if (!record) return { ...base, state: 'add' as const, preservation };
        if (!hash)
          return {
            ...base,
            state: 'update-managed' as const,
            installedHash: record.contentHash,
            preservation,
          };
        if (hash !== record.contentHash)
          return {
            ...base,
            state: 'managed-drift' as const,
            currentHash: hash,
            installedHash: record.contentHash,
            preservation,
          };
        return {
          ...base,
          state: 'update-managed' as const,
          currentHash: hash,
          installedHash: record.contentHash,
          preservation,
        };
      }),
    );
    const desiredIds = new Set(
      environment.skills.map((skill) => skill.entryId),
    );
    for (const record of registry.bindings.filter(
      (item) =>
        item.environment === environment.name &&
        item.targetRoot === (this.options.targetRootKind ?? 'agents') &&
        !desiredIds.has(item.environmentEntryId),
    )) {
      const hash = await currentHash(record.targetPath);
      operations.push({
        entryId: record.environmentEntryId,
        skillName: record.skillName,
        contentHash: record.contentHash,
        targetPath: record.targetPath,
        installedHash: record.contentHash,
        stale: true,
        ...(hash ? { currentHash: hash } : {}),
        state: hash === record.contentHash ? 'remove-managed' : 'managed-drift',
      });
    }
    return bindingPlanSchema.parse({
      schemaVersion: 1,
      agent: this.id,
      environment: environment.name,
      targetRoot: this.targetRoot,
      operations,
      blocking: operations.some(
        (item) =>
          blockedStates.has(item.state) ||
          (item.state === 'managed-drift' && item.stale),
      ),
    });
  }
  async applyBindings(
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult> {
    if (plan.blocking) throw new BindingConflictError();
    const registry = await readBindingRegistry({
      stackHome: this.options.stackHome,
      machineId,
    });
    const backups: Array<{ target: string; backup?: string }> = [];
    const applied: BindingRecord[] = [];
    const removed: BindingRecord[] = [];
    try {
      for (const operation of plan.operations) {
        if (operation.state === 'remove-managed') {
          let record: BindingRecord | undefined;
          for (const item of registry.bindings)
            if (
              item.environmentEntryId === operation.entryId &&
              (await pathsEqual({
                left: item.targetPath,
                right: operation.targetPath,
              }))
            ) {
              record = item;
              break;
            }
          if (
            !record ||
            (await currentHash(operation.targetPath)) !== record.contentHash
          )
            throw new BindingConflictError(
              'A stale managed binding changed before removal.',
            );
          const backup = `${operation.targetPath}.${randomUUID()}.stack-rollback`;
          await rename(operation.targetPath, backup);
          backups.push({ target: operation.targetPath, backup });
          registry.bindings = registry.bindings.filter(
            (item) =>
              !(
                item.environmentEntryId === operation.entryId &&
                item.targetRoot === (this.options.targetRootKind ?? 'agents')
              ),
          );
          removed.push(record);
          continue;
        }
        if (
          !['add', 'update-managed', 'managed-drift'].includes(operation.state)
        )
          continue;
        const hashAtApply = await currentHash(operation.targetPath);
        if (operation.state === 'add' && hashAtApply)
          throw new BindingConflictError(
            'An unmanaged Codex target appeared after binding approval.',
          );
        if (operation.state !== 'add' && hashAtApply !== operation.currentHash)
          throw new BindingConflictError(
            'A managed Codex target changed after binding approval.',
          );
        let backup: string | undefined;
        if (await exists(operation.targetPath)) {
          backup = `${operation.targetPath}.${randomUUID()}.stack-rollback`;
          await rename(operation.targetPath, backup);
        }
        backups.push({
          target: operation.targetPath,
          ...(backup ? { backup } : {}),
        });
        await (this.options.materialize ?? materializeStoredSkill)({
          stackHome: this.options.stackHome,
          contentHash: operation.contentHash,
          targetPath: operation.targetPath,
        });
        const record: BindingRecord = {
          environment: plan.environment,
          environmentEntryId: operation.entryId,
          skillName: operation.skillName,
          contentHash: operation.contentHash,
          targetPath: operation.targetPath,
          targetRoot: this.options.targetRootKind ?? 'agents',
          createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
        };
        registry.bindings = registry.bindings.filter(
          (item) =>
            !(
              item.environmentEntryId === operation.entryId &&
              item.targetRoot === (this.options.targetRootKind ?? 'agents')
            ),
        );
        registry.bindings.push(record);
        applied.push(record);
      }
      registry.bindings.sort((a, b) =>
        a.environmentEntryId.localeCompare(b.environmentEntryId),
      );
      await (this.options.writeRegistry ?? writeBindingRegistry)(
        bindingRegistryPath(this.options.stackHome, machineId),
        registry,
      );
      for (const item of backups)
        if (item.backup)
          await rm(item.backup, { recursive: true, force: true }).catch(
            () => undefined,
          );
      return bindingApplyResultSchema.parse({
        agent: this.id,
        applied,
        removed,
        unchanged: plan.operations.length - applied.length - removed.length,
        rolledBack: false,
      });
    } catch (error) {
      try {
        for (const item of backups.reverse()) {
          await rm(item.target, { recursive: true, force: true });
          if (item.backup) await rename(item.backup, item.target);
        }
      } catch (rollbackError) {
        throw new BindingRollbackFailedError('Codex binding rollback failed.', {
          cause: rollbackError,
        });
      }
      throw new BindingApplyFailedError(
        'Codex bindings could not be applied; filesystem changes were rolled back.',
        { cause: error },
      );
    }
  }
  async verifyBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification> {
    const registry = await readBindingRegistry({
      stackHome: this.options.stackHome,
      machineId: environment.machineId,
    });
    const bindings = await Promise.all(
      registry.bindings
        .filter(
          (record) =>
            record.environment === environment.name &&
            record.targetRoot === (this.options.targetRootKind ?? 'agents'),
        )
        .map(async (record) => {
          const hash = await currentHash(record.targetPath);
          return {
            record,
            state: !hash
              ? ('missing' as const)
              : hash === record.contentHash
                ? ('healthy' as const)
                : ('changed' as const),
            ...(hash ? { currentHash: hash } : {}),
          };
        }),
    );
    return bindingVerificationSchema.parse({
      agent: this.id,
      healthy: bindings.every((item) => item.state === 'healthy'),
      bindings,
    });
  }
  async removeBindings(
    request: BindingRemovalRequest,
  ): Promise<BindingApplyResult> {
    const registry = await readBindingRegistry({
      stackHome: this.options.stackHome,
      machineId: request.machineId,
    });
    const selected = registry.bindings.filter(
      (item) =>
        item.targetRoot === (this.options.targetRootKind ?? 'agents') &&
        request.environmentEntryIds.includes(item.environmentEntryId),
    );
    if (selected.length !== new Set(request.environmentEntryIds).size)
      throw new BindingConflictError(
        'Removal request includes a Codex binding that Stack does not own.',
      );
    for (const record of selected) {
      const hash = await currentHash(record.targetPath);
      if (hash !== record.contentHash)
        throw new BindingConflictError(
          `Managed Codex binding was modified and will not be removed: ${record.targetPath}`,
        );
    }
    const backups: Array<{ record: BindingRecord; backup: string }> = [];
    try {
      for (const record of selected) {
        const backup = `${record.targetPath}.${randomUUID()}.stack-remove`;
        await rename(record.targetPath, backup);
        backups.push({ record, backup });
      }
      registry.bindings = registry.bindings.filter(
        (item) =>
          !(
            item.targetRoot === (this.options.targetRootKind ?? 'agents') &&
            request.environmentEntryIds.includes(item.environmentEntryId)
          ),
      );
      await (this.options.writeRegistry ?? writeBindingRegistry)(
        bindingRegistryPath(this.options.stackHome, request.machineId),
        registry,
      );
      for (const item of backups)
        await rm(item.backup, { recursive: true, force: true }).catch(
          () => undefined,
        );
    } catch (error) {
      try {
        for (const item of backups.reverse())
          await rename(item.backup, item.record.targetPath);
      } catch (rollbackError) {
        throw new BindingRollbackFailedError(
          'Codex binding removal rollback failed.',
          { cause: rollbackError },
        );
      }
      throw new BindingApplyFailedError(
        'Codex bindings could not be removed; filesystem changes were rolled back.',
        { cause: error },
      );
    }
    return bindingApplyResultSchema.parse({
      agent: this.id,
      applied: [],
      removed: selected,
      unchanged: registry.bindings.length,
      rolledBack: false,
    });
  }
  launch(context: LaunchContext) {
    return this.detect().then((detection) =>
      launchAgent({
        agent: this.id,
        ...context,
        detection,
        ...(this.options.spawnProcess
          ? { spawnProcess: this.options.spawnProcess }
          : {}),
      }),
    );
  }
}
export class CodexAdapter extends FilesystemSkillAdapter {
  constructor(options: CodexAdapterOptions) {
    super({ ...options, agent: 'codex', targetRootKind: 'agents' });
  }
}

const directSpawn: SpawnProcess = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
export const launchCodex = async (options: {
  detection: AgentDetection;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
}): Promise<LaunchResult> => {
  return launchAgent({ agent: 'codex', ...options });
};
export const launchAgent = async (options: {
  agent: AgentId;
  detection: AgentDetection;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
}): Promise<LaunchResult> => {
  if (!options.detection.installed || !options.detection.executablePath)
    throw new AgentNotInstalledError();
  try {
    const result = await (options.spawnProcess ?? directSpawn)(
      options.detection.executablePath,
      [],
      {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: false,
        stdio: 'inherit',
      },
    );
    return launchResultSchema.parse({
      agent: options.agent,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
    });
  } catch (error) {
    throw new AgentLaunchFailedError(
      `${options.agent} could not be launched.`,
      {
        cause: error,
      },
    );
  }
};

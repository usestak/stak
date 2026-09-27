import { readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import {
  diffMainEnvironment,
  applyRemoteStackUse,
  applyStackRemove,
  applyStackUse,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareRemoteStackUse,
  prepareStackRemove,
  prepareStackUse,
  preserveRemoteTrialStack,
  resolvePublicStackSource,
  resolveRemoteTrialStack,
  resolveStackHome,
  spawnGit,
  statusMainEnvironment,
  preserveTrialStack,
  resolveTrialStack,
} from '@stack/core';
import {
  CodexAdapter,
  CursorAdapter,
  ClaudeAdapter,
  cleanupCodexTryRuntime,
  launchCodexTryRuntime,
  prepareCodexTryRuntime,
  recoverStaleTryRuntimes,
} from '@stack/adapters';
import type { InitializeMainEnvironmentResult } from '@stack/core';
import type {
  RemoteTrialResolution,
  StackRemoteUseProposal,
  StackRemoveProposal,
  StackUseProposal,
  TrialStackResolution,
} from '@stack/core';
import {
  createClaudeMemoryAdapter,
  fileLocalMemoryKeyStore,
  generateRecoveryKey,
  readMemoryStatus,
  type BackupResult,
  type DiscoveredMemoryItem,
  type MemoryStatus,
  type RemoteMemoryBackend,
  type RestorePlan,
} from '@stack/memory';
import { createCloudClient } from '@stack/cloud-client';
import { resolveMemoryProjects } from './memory/resolve.js';
import { resolveCloudBaseUrl } from './cloud/config.js';
import { stackCloudRemoteMemoryBackend } from './memory/cloud-backend.js';
import {
  readMemoryCloudStatus,
  runMemoryCloudBackup,
  runMemoryCloudProtect,
  runMemoryCloudRecover,
  runPasskeyProtect,
  runPasskeyRecover,
  type CloudRecoverOutcome,
  type MemoryBackupOutcome,
  type MemoryCloudDeps,
  type MemoryCloudStatus,
  type PasskeyBridgeDeps,
  type PasskeyProtectResult,
  type PasskeyRecoverResult,
} from './memory/cloud-ops.js';
import { defaultOpenBrowser } from './cloud/operations.js';
import type { MemoryProtectCommandResult } from './commands/memory.js';
import { resolveScanRoots, scanSkills } from '@stack/scanner';
import { isPublicStackRef } from '@stack/spec';
import type {
  AgentDetection,
  AgentId,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  EnvironmentDiff,
  EnvironmentStatus,
  LaunchResult,
  PublishPublicStackVersionResponse,
  ResolvedLocalEnvironment,
  ScanResult,
  TryExitResult,
  TryPreparationResult,
} from '@stack/spec';

import type {
  ApplyPullResult,
  ApplyPushResult,
  PublishPlan,
  PullPlan,
  PushPlan,
} from '@stack/core';

import { registerDiffCommand } from './commands/diff.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerStatusCommand } from './commands/status.js';
import { registerRunCommand } from './commands/run.js';
import { registerUseCommand } from './commands/use.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerTryCommand } from './commands/try.js';
import { registerLoginCommand } from './commands/login.js';
import { registerLogoutCommand } from './commands/logout.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import { registerPushCommand } from './commands/push.js';
import { registerPullCommand } from './commands/pull.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerProjectCommand } from './commands/project.js';
import {
  listProjects,
  mapProject,
  type MapProjectResult,
  type ProjectListRow,
} from './memory/project-ops.js';
import { fileCredentialStore } from './cloud/credentials.js';
import {
  cloudApplyPublish,
  cloudApplyPull,
  cloudApplyPush,
  cloudPreparePublish,
  cloudPreparePull,
  cloudPreparePush,
  performLogin,
  performLogout,
  performWhoami,
  publicReadClient,
  type CloudOperationsDeps,
  type LoginResult,
  type LogoutResult,
  type WhoamiResult,
} from './cloud/operations.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

export type ProgramDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  initialize(scanResult: ScanResult): Promise<InitializeMainEnvironmentResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  detectAgents?(): Promise<Array<{ agent: AgentId; ready: boolean }>>;
  diff(scanResult: ScanResult): Promise<EnvironmentDiff>;
  prepareUse(input: string): Promise<StackUseProposal | StackRemoteUseProposal>;
  applyUse(
    proposal: StackUseProposal | StackRemoteUseProposal,
  ): Promise<unknown>;
  prepareRemove(identifier: string): Promise<StackRemoveProposal>;
  applyRemove(proposal: StackRemoveProposal): Promise<unknown>;
  loadRunEnvironment(): Promise<ResolvedLocalEnvironment>;
  detectCodex(): Promise<AgentDetection>;
  planCodexBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingPlan>;
  applyCodexBindings(
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult>;
  verifyCodexBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification>;
  launchCodex(): Promise<LaunchResult>;
  detectAgent?(agent: AgentId): Promise<AgentDetection>;
  planAgentBindings?(
    agent: AgentId,
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingPlan>;
  applyAgentBindings?(
    agent: AgentId,
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult>;
  verifyAgentBindings?(
    agent: AgentId,
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification>;
  launchAgent?(agent: AgentId): Promise<LaunchResult>;
  resolveTry(
    input: string,
  ): Promise<TrialStackResolution | RemoteTrialResolution>;
  preserveTry(
    trial: TrialStackResolution | RemoteTrialResolution,
  ): Promise<void>;
  prepareTry(
    trial: TrialStackResolution | RemoteTrialResolution,
  ): Promise<TryPreparationResult>;
  cleanupTry(preparation: TryPreparationResult): Promise<void>;
  launchTry(
    preparation: TryPreparationResult,
    detection: AgentDetection,
  ): Promise<TryExitResult>;
  cloudLogin(options: {
    apiUrl?: string;
    label?: string;
    openBrowser?: boolean;
  }): Promise<LoginResult>;
  cloudLogout(): Promise<LogoutResult>;
  cloudWhoami(): Promise<WhoamiResult>;
  cloudPreparePush(): Promise<PushPlan>;
  cloudApplyPush(plan: PushPlan): Promise<ApplyPushResult>;
  cloudPreparePull(): Promise<PullPlan>;
  cloudApplyPull(plan: PullPlan): Promise<ApplyPullResult>;
  cloudPreparePublish(options: {
    input: string;
    slug?: string;
  }): Promise<PublishPlan>;
  cloudApplyPublish(
    plan: PublishPlan,
  ): Promise<PublishPublicStackVersionResponse>;
  memoryScan(): Promise<DiscoveredMemoryItem[]>;
  memoryBackup(): Promise<BackupResult>;
  memoryStatus(): Promise<MemoryStatus | null>;
  memoryRestore(options: { apply: boolean }): Promise<RestorePlan>;
  memoryCloudBackup(): Promise<MemoryBackupOutcome>;
  memoryCloudRecover(options: {
    generation?: number;
    recoveryFile?: string;
  }): Promise<CloudRecoverOutcome>;
  memoryCloudProtect(options: {
    recoveryFile?: string;
  }): Promise<MemoryProtectCommandResult>;
  memoryProtectPasskey(): Promise<PasskeyProtectResult>;
  memoryRecoverPasskey(): Promise<PasskeyRecoverResult>;
  memoryCloudStatus(): Promise<MemoryCloudStatus>;
  projectList(): Promise<ProjectListRow[]>;
  projectMap(options: {
    project: string;
    dir: string;
  }): Promise<MapProjectResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

/**
 * Resolve the local projects the memory adapter uses to attach a portable Git
 * identity to project-scoped memory. Best-effort and read-only.
 */
const gitOriginOf = async (dir: string): Promise<string | undefined> => {
  try {
    const result = await spawnGit(['config', '--get', 'remote.origin.url'], {
      cwd: dir,
      env: process.env,
    });
    const remote = result.stdout.trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
};

const listChildDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

const claudeHome = path.join(os.homedir(), '.claude');

const memoryAdapter = async () =>
  createClaudeMemoryAdapter({
    stackHome,
    claudeHome,
    platform: process.platform,
    projects: await resolveMemoryProjects({
      cwd: process.cwd(),
      platform: process.platform,
      listDirs: listChildDirs,
      gitOrigin: gitOriginOf,
    }),
  });

const stackHome = resolveStackHome();
const codex = new CodexAdapter({ stackHome, homeDir: os.homedir() });
const cursor = new CursorAdapter({ stackHome, homeDir: os.homedir() });
const claude = new ClaudeAdapter({ stackHome, homeDir: os.homedir() });
const adapters = { codex, cursor, claude };
const cloudDeps: CloudOperationsDeps = {
  stackHome,
  env: process.env,
  credentials: fileCredentialStore(stackHome),
  writeOut: (value) => process.stdout.write(value),
};
/**
 * Build the remote-Memory operation deps: an authenticated per-user cloud backend
 * (or null when signed out), the device-local key store, and the Phase 14A local
 * backup runner.
 */
const buildMemoryCloudDeps = async (): Promise<MemoryCloudDeps> => {
  const credential = await cloudDeps.credentials.read();
  let backend: RemoteMemoryBackend | null = null;
  if (credential) {
    const baseUrl = resolveCloudBaseUrl({
      env: process.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    backend = stackCloudRemoteMemoryBackend(
      createCloudClient({ baseUrl, token: credential.token }),
    );
  }
  return {
    stackHome,
    backend,
    localKeyStore: fileLocalMemoryKeyStore(stackHome),
    runLocalBackup: async () => (await memoryAdapter()).backup(),
  };
};

/** Passkey bridge deps: the cloud backend + device key store + a browser opener. */
const buildPasskeyDeps = async (): Promise<PasskeyBridgeDeps> => {
  const base = await buildMemoryCloudDeps();
  const credential = await cloudDeps.credentials.read();
  const webBaseUrl =
    credential !== null
      ? resolveCloudBaseUrl({
          env: process.env,
          ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
        })
      : '';
  return {
    stackHome: base.stackHome,
    backend: base.backend,
    localKeyStore: base.localKeyStore,
    webBaseUrl,
    openBrowser: async (url) => {
      process.stdout.write(`Opening ${url}\n`);
      await defaultOpenBrowser(url);
    },
  };
};

/** Write a `.stackkey` recovery file without overwriting, owner-only. */
const writeRecoveryFile = async (
  filePath: string,
  file: unknown,
): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

const defaultDependencies: ProgramDependencies = {
  scan: async ({ project }) =>
    scanSkills({ roots: resolveScanRoots({ includeProject: project }) }),
  initialize: async (scanResult) =>
    initializeMainEnvironment({ stackHome, scanResult }),
  status: async (scanResult) =>
    statusMainEnvironment({ stackHome, scanResult }),
  detectAgents: async () => {
    const detections = await Promise.all(
      [codex, cursor, claude].map((adapter) =>
        adapter.detect().catch(() => undefined),
      ),
    );
    return detections
      .filter((detection): detection is AgentDetection => detection != null)
      .map((detection) => ({
        agent: detection.agent,
        ready: detection.installed,
      }));
  },
  diff: async (scanResult) => diffMainEnvironment({ stackHome, scanResult }),
  prepareUse: async (input) => {
    if (!isPublicStackRef(input)) return prepareStackUse({ stackHome, input });
    const source = await resolvePublicStackSource({
      client: await publicReadClient(cloudDeps),
      ref: input,
    });
    return prepareRemoteStackUse({ stackHome, source });
  },
  applyUse: (proposal) =>
    'source' in proposal
      ? applyRemoteStackUse(proposal, { gitExecutor: spawnGit })
      : applyStackUse(proposal),
  prepareRemove: (identifier) => prepareStackRemove({ stackHome, identifier }),
  applyRemove: (proposal) => applyStackRemove(proposal),
  loadRunEnvironment: async () => {
    const state = await loadMainEnvironment({ stackHome });
    return {
      name: state.manifest.name,
      machineId: state.machine.machineId,
      skills: Object.entries(state.lock.skills).map(([entryId, locked]) => {
        return {
          entryId,
          name: locked.name,
          contentHash: locked.contentHash,
        };
      }),
    };
  },
  detectCodex: () => codex.detect(),
  planCodexBindings: (environment) => codex.planBindings(environment),
  applyCodexBindings: (plan, machineId) => codex.applyBindings(plan, machineId),
  verifyCodexBindings: (environment) => codex.verifyBindings(environment),
  launchCodex: () => codex.launch({ cwd: process.cwd(), env: process.env }),
  detectAgent: (agent) => adapters[agent].detect(),
  planAgentBindings: (agent, environment) =>
    adapters[agent].planBindings(environment),
  applyAgentBindings: (agent, plan, machineId) =>
    adapters[agent].applyBindings(plan, machineId),
  verifyAgentBindings: (agent, environment) =>
    adapters[agent].verifyBindings(environment),
  launchAgent: (agent) =>
    adapters[agent].launch({ cwd: process.cwd(), env: process.env }),
  resolveTry: async (input) =>
    isPublicStackRef(input)
      ? resolveRemoteTrialStack({
          ref: input,
          client: await publicReadClient(cloudDeps),
        })
      : resolveTrialStack({ input }),
  preserveTry: (trial) =>
    'references' in trial
      ? preserveRemoteTrialStack({ stackHome, trial, gitExecutor: spawnGit })
      : preserveTrialStack({ stackHome, trial }),
  prepareTry: async (trial) => {
    // Conservatively retry any prior runtimes left in cleanup-failed before
    // creating a new one (best-effort; never blocks the trial).
    await recoverStaleTryRuntimes({ stackHome }).catch(() => undefined);
    return prepareCodexTryRuntime({
      stackHome,
      trial: trial.resolved,
      homeDir: os.homedir(),
      env: process.env,
    });
  },
  cleanupTry: async (preparation) => {
    await cleanupCodexTryRuntime({ stackHome, session: preparation.session });
  },
  launchTry: (preparation, detection) =>
    launchCodexTryRuntime({ stackHome, preparation, detection }),
  cloudLogin: (options) => performLogin(cloudDeps, options),
  cloudLogout: () => performLogout(cloudDeps),
  cloudWhoami: () => performWhoami(cloudDeps),
  cloudPreparePush: () => cloudPreparePush(cloudDeps),
  cloudApplyPush: (plan) => cloudApplyPush(cloudDeps, plan),
  cloudPreparePull: () => cloudPreparePull(cloudDeps),
  cloudApplyPull: (plan) => cloudApplyPull(cloudDeps, plan),
  cloudPreparePublish: (options) => cloudPreparePublish(cloudDeps, options),
  cloudApplyPublish: (plan) => cloudApplyPublish(cloudDeps, plan),
  memoryScan: async () => (await memoryAdapter()).discover(),
  memoryBackup: async () => (await memoryAdapter()).backup(),
  memoryStatus: async () => readMemoryStatus(stackHome),
  memoryRestore: async ({ apply }) =>
    (await memoryAdapter()).restore({ apply }),
  memoryCloudBackup: async () =>
    runMemoryCloudBackup(await buildMemoryCloudDeps()),
  memoryCloudRecover: async (options) =>
    runMemoryCloudRecover(await buildMemoryCloudDeps(), options),
  memoryCloudStatus: async () =>
    readMemoryCloudStatus(await buildMemoryCloudDeps()),
  memoryCloudProtect: async (options) => {
    const deps = await buildMemoryCloudDeps();
    if (!deps.backend) return { status: 'not-authenticated' as const };
    const recoveryKey = generateRecoveryKey();
    const result = await runMemoryCloudProtect(
      { ...deps, backend: deps.backend },
      { recoveryKey },
    );
    // Fail closed: if local key storage couldn't be secured, do NOT write the
    // recovery file and report the insecure-local-key status.
    if (result.status === 'insecure-local-key')
      return { status: 'insecure-local-key' as const };
    const recoveryFilePath =
      options.recoveryFile ??
      path.join(process.cwd(), 'stack-memory-recovery.stackkey');
    await writeRecoveryFile(recoveryFilePath, recoveryKey.file);
    return { migrated: result.migrated, recoveryFilePath };
  },
  memoryProtectPasskey: async () => runPasskeyProtect(await buildPasskeyDeps()),
  memoryRecoverPasskey: async () => runPasskeyRecover(await buildPasskeyDeps()),
  projectList: async () =>
    listProjects({
      stackHome,
      projects: await resolveMemoryProjects({
        cwd: process.cwd(),
        platform: process.platform,
        listDirs: listChildDirs,
        gitOrigin: gitOriginOf,
      }),
    }),
  projectMap: async ({ project, dir }) =>
    mapProject({ stackHome, selector: project, dir, gitOrigin: gitOriginOf }),
  confirm: async (message) => {
    if (!process.stdin.isTTY) return false;
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(`${message} [y/N] `);
      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  },
  writeOut: (value) => process.stdout.write(value),
};

export const createProgram = (
  dependencies: ProgramDependencies = defaultDependencies,
): Command => {
  const program = new Command()
    .name('stack')
    .description('The control plane for portable AI agent environments.')
    .version(packageMetadata.version);
  registerScanCommand(program, dependencies);
  registerInitCommand(program, dependencies);
  registerStatusCommand(program, dependencies);
  registerDiffCommand(program, dependencies);
  registerUseCommand(program, dependencies);
  registerRemoveCommand(program, dependencies);
  registerRunCommand(program, dependencies);
  registerTryCommand(program, dependencies);
  registerLoginCommand(program, dependencies);
  registerLogoutCommand(program, dependencies);
  registerWhoamiCommand(program, dependencies);
  registerPushCommand(program, dependencies);
  registerPullCommand(program, dependencies);
  registerPublishCommand(program, dependencies);
  registerMemoryCommand(program, dependencies);
  registerProjectCommand(program, dependencies);
  return program;
};

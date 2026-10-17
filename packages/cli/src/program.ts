import { readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import {
  diffMainEnvironment,
  applyOwnedStackUse,
  applyRemoteStackUse,
  applyStackRemove,
  applyStackUse,
  getOrCreateMachineIdentity,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareOwnedStackUse,
  prepareRemoteStackUse,
  prepareStackRemove,
  prepareStackUse,
  preserveRemoteTrialStack,
  projectedLocalEnvironment,
  resolveOwnedStackSource,
  resolvePublicStackSource,
  resolveRemoteTrialStack,
  resolveSkillSelector,
  resolveStackHome,
  setSkillPaused,
  spawnGit,
  StackCompositionError,
  StackStateError,
  statusMainEnvironment,
  preserveTrialStack,
  resolveTrialStack,
} from '@stack/core';
import {
  BindingConflictError,
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
  SetSkillPausedResult,
  StackOwnedUseProposal,
  StackRemoteUseProposal,
  StackRemoveProposal,
  StackUseProposal,
  TrialStackResolution,
} from '@stack/core';
import {
  adoptReconciledProjectId,
  createClaudeMemoryAdapter,
  fileLocalMemoryKeyStore,
  generateRecoveryKey,
  readLocalRegistry,
  readMemoryManifest,
  readMemoryStatus,
  writeLocalRegistry,
  type BackupResult,
  type DiscoveredMemoryItem,
  type MemoryStatus,
  type RemoteMemoryBackend,
  type RestorePlan,
} from '@stack/memory';
import { createCloudClient, NotAuthenticatedError } from '@stack/cloud-client';
import { runSkillCheck, type SkillCheckResult } from './skill-check-runner.js';
import {
  CHECKIN_COMMANDS,
  gatherCheckinInputs,
  installedSkillsFrom,
  nativeMemoryBackedUp,
  projectPresenceFrom,
  projectSyncPayloadFrom,
  reportCheckin,
} from './cloud/checkin.js';
import { resolveMemoryProjects } from './memory/resolve.js';
import {
  buildOpenUrl,
  resolveCloudAppUrl,
  resolveCloudBaseUrl,
} from './cloud/config.js';
import { registerOpenCommand } from './commands/open.js';
import { stackCloudRemoteMemoryBackend } from './memory/cloud-backend.js';
import {
  freshRegistryRisksDuplication,
  readBackupSupersession,
  readMemoryCloudStatus,
  runMemoryCloudBackup,
  runMemoryCloudProtect,
  runMemoryCloudRecover,
  runMemoryGenerations,
  runPasskeyProtect,
  runPasskeyRecover,
  type CloudRecoverOutcome,
  type MemoryBackupOutcome,
  type MemoryCloudDeps,
  type MemoryCloudStatus,
  type MemoryGenerationsOutcome,
  type PasskeyBridgeDeps,
  type PasskeyProtectResult,
  type PasskeyRecoverResult,
} from './memory/cloud-ops.js';
import { defaultOpenBrowser } from './cloud/operations.js';
import type { MemoryProtectCommandResult } from './commands/memory.js';
import type { MemoryBackupPreview } from './ui/memory.js';
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
import {
  registerProjectCommand,
  type CloudLifecyclePropagation,
} from './commands/project.js';
import {
  registerSkillCommand,
  type SkillUpdateResult,
  type SkillUpdateAgentResult,
} from './commands/skill.js';
import {
  listProjects,
  mapProject,
  setProjectLifecycle,
  type MapProjectResult,
  type ProjectListRow,
  type SetLifecycleResult,
} from './memory/project-ops.js';
import { fileCredentialStore } from './cloud/credentials.js';
import {
  authenticatedClient,
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
  prepareUse(
    input: string,
  ): Promise<StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal>;
  applyUse(
    proposal: StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal,
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
  memoryBackupPreview(): Promise<MemoryBackupPreview>;
  memoryCloudBackup(): Promise<MemoryBackupOutcome>;
  memoryCloudRecover(options: {
    generation?: number;
    recoveryFile?: string;
  }): Promise<CloudRecoverOutcome>;
  memoryGenerations(): Promise<MemoryGenerationsOutcome>;
  memoryCloudProtect(options: {
    recoveryFile?: string;
  }): Promise<MemoryProtectCommandResult>;
  memoryProtectPasskey(): Promise<PasskeyProtectResult>;
  memoryRecoverPasskey(options: {
    generation?: number;
  }): Promise<PasskeyRecoverResult>;
  memoryCloudStatus(): Promise<MemoryCloudStatus>;
  projectList(): Promise<ProjectListRow[]>;
  projectMap(options: {
    project: string;
    dir: string;
  }): Promise<MapProjectResult>;
  projectArchive(options: { project: string }): Promise<SetLifecycleResult>;
  projectUnarchive(options: { project: string }): Promise<SetLifecycleResult>;
  skillUpdate(options: { selector?: string }): Promise<SkillUpdateResult>;
  skillPause(options: { selector: string }): Promise<SetSkillPausedResult>;
  skillResume(options: { selector: string }): Promise<SetSkillPausedResult>;
  skillCheck(options: { selector?: string }): Promise<SkillCheckResult>;
  machineId(): Promise<string>;
  openUrl(machineId: string): string;
  openBrowser(url: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
  /**
   * Phase P1: best-effort machine check-in after a state-changing command succeeds.
   * Optional so the test harness can omit it; the real CLI wires it in
   * `defaultDependencies`. Connectivity failures are non-fatal; a 401/403 is re-thrown.
   */
  reportMachineCheckin?(commandName: string): Promise<void>;
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

const isDirectoryAt = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

const memoryAdapter = async () =>
  createClaudeMemoryAdapter({
    stackHome,
    claudeHome,
    platform: process.platform,
    // Resolve strong Git identity from each project's own checkout so scan and
    // backup agree regardless of the current working directory (Phase 15B.4).
    gitRemoteOf: gitOriginOf,
    isDirectory: isDirectoryAt,
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

/**
 * Mirror an explicit CLI lifecycle change to the account (Cloud). Best-effort and truthful:
 * signed out → `not-signed-in` (nothing to propagate); a connectivity/other failure →
 * `failed` so the CLI tells the user to re-run when connected. This is explicit lifecycle
 * intent, never discovery sync, so it is the Cloud lifecycle authority alongside the web.
 */
const propagateProjectLifecycle = async (
  projectId: string,
  lifecycle: 'active' | 'archived',
): Promise<CloudLifecyclePropagation> => {
  const credential = await cloudDeps.credentials.read();
  if (!credential) return 'not-signed-in';
  try {
    const baseUrl = resolveCloudBaseUrl({
      env: process.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    const client = createCloudClient({ baseUrl, token: credential.token });
    await client.setProjectLifecycle(projectId, lifecycle);
    return 'ok';
  } catch {
    return 'failed';
  }
};

/**
 * Launch the OS default browser at a URL, detached, without blocking or capturing output. No
 * network call of our own; the browser handles everything (including web sign-in if needed).
 */
const launchBrowser = async (url: string): Promise<void> => {
  const { spawn } = await import('node:child_process');
  const [command, args] =
    process.platform === 'win32'
      ? (['cmd', ['/c', 'start', '', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  const child = spawn(command, [...args], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
};

// Neither ResolvedOwnedStackSource nor ResolvedPublicStackSource carries a `kind` field, so
// the discriminator uses a field unique to each: `stackId` only exists on the owned source,
// `owner` only exists on the public-ref source (and StackUseProposal has neither — it carries
// `loaded`, not `source`, so it never matches either check below).
// Exported for direct unit testing (see program.test.ts) — this exact discrimination
// previously used a `'kind' in proposal.source` check that could never be true for either
// variant, silently misrouting every owned-Stack `applyUse` through the remote-Stack path.
export const isOwnedUseProposal = (
  proposal: StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal,
): proposal is StackOwnedUseProposal =>
  'source' in proposal && 'stackId' in proposal.source;
export const isRemoteUseProposal = (
  proposal: StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal,
): proposal is StackRemoteUseProposal =>
  'source' in proposal && 'owner' in proposal.source;

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
    if (isPublicStackRef(input)) {
      const source = await resolvePublicStackSource({
        client: await publicReadClient(cloudDeps),
        ref: input,
      });
      return prepareRemoteStackUse({ stackHome, source });
    }
    try {
      return await prepareStackUse({ stackHome, input });
    } catch (error) {
      // Fall back to the caller's own Cloud named Stack (§14) only when no local Stack
      // manifest exists at this path — any other local error (cycle, invalid manifest,
      // already-active conflict) must surface as-is, never masked by a Cloud lookup.
      if (!(
        error instanceof StackCompositionError &&
        error.code === 'stack-manifest-not-found'
      ))
        throw error;
      const source = await resolveOwnedStackSource({
        client: await authenticatedClient(cloudDeps),
        name: input,
      });
      return prepareOwnedStackUse({ stackHome, source });
    }
  },
  applyUse: async (proposal) =>
    isOwnedUseProposal(proposal)
      ? applyOwnedStackUse(proposal, { gitExecutor: spawnGit })
      : isRemoteUseProposal(proposal)
        ? applyRemoteStackUse(proposal, {
            gitExecutor: spawnGit,
            client: await publicReadClient(cloudDeps),
          })
        : applyStackUse(proposal),
  prepareRemove: (identifier) => prepareStackRemove({ stackHome, identifier }),
  applyRemove: (proposal) => applyStackRemove(proposal),
  // `stak run` projects through the same paused-aware helper as `stak skill update`, so a
  // paused Skill is excluded from the real agent projection path (contract §6).
  loadRunEnvironment: async () =>
    projectedLocalEnvironment(await loadMainEnvironment({ stackHome })),
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
  preserveTry: async (trial) =>
    'restorations' in trial
      ? preserveRemoteTrialStack({
          stackHome,
          trial,
          gitExecutor: spawnGit,
          client: await publicReadClient(cloudDeps),
        })
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
  memoryBackupPreview: async () => {
    // Non-mutating: preview composition + supersession locally, read Cloud privacy
    // without writing anything.
    const composition = await (await memoryAdapter()).previewBackup();
    const cloud = await buildMemoryCloudDeps();
    let privacy: 'standard' | 'protected' | null = null;
    if (cloud.backend) {
      const profile = await cloud.backend.getProfile();
      privacy = profile?.privacyMode ?? 'standard';
    }
    const supersession = await readBackupSupersession(cloud);
    const risksDuplicatingLocalProjects = freshRegistryRisksDuplication({
      localRecoveredGeneration: supersession.localRecoveredGeneration,
      cloudLatestGeneration: supersession.cloudLatestGeneration,
      nativeItems: composition.native,
      registry: await readLocalRegistry(stackHome),
    });
    return {
      ...composition,
      privacy,
      supersession,
      risksDuplicatingLocalProjects,
    };
  },
  memoryCloudBackup: async () =>
    runMemoryCloudBackup(await buildMemoryCloudDeps()),
  memoryCloudRecover: async (options) =>
    runMemoryCloudRecover(await buildMemoryCloudDeps(), options),
  memoryGenerations: async () =>
    runMemoryGenerations(await buildMemoryCloudDeps()),
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
  memoryRecoverPasskey: async (options) =>
    runPasskeyRecover(await buildPasskeyDeps(), options),
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
  projectArchive: async ({ project }) => {
    const result = await setProjectLifecycle({
      stackHome,
      selector: project,
      lifecycle: 'archived',
    });
    if (result.status !== 'ok') return result;
    // Mirror the explicit lifecycle intent to the account (Cloud) — always, even when the
    // local state was already archived, so re-running while connected reconciles a prior
    // offline change. Lifecycle is one logical account state, never discovery sync.
    return {
      ...result,
      cloudPropagation: await propagateProjectLifecycle(
        result.projectId,
        'archived',
      ),
    };
  },
  projectUnarchive: async ({ project }) => {
    const result = await setProjectLifecycle({
      stackHome,
      selector: project,
      lifecycle: 'active',
    });
    if (result.status !== 'ok') return result;
    return {
      ...result,
      cloudPropagation: await propagateProjectLifecycle(
        result.projectId,
        'active',
      ),
    };
  },
  // `stak skill update` installs/reconciles APPROVED desired versions onto THIS machine across
  // every detected agent (no launch) — reusing the same transactional binding plan/apply/verify
  // as `run`. Paused Skills are excluded by `projectedLocalEnvironment`, so they are dropped
  // from projection here too. A selector narrows the applied operations to one stable entryId
  // without disturbing other Skills. Any rollback/verification failure throws, so the command
  // fails and does NOT check in; that machine reports the drift at its next check-in.
  skillUpdate: async ({ selector }) => {
    let state;
    try {
      state = await loadMainEnvironment({ stackHome });
    } catch (error) {
      if (
        error instanceof StackStateError &&
        error.code === 'environment-not-found'
      )
        return { status: 'no-environment' as const };
      throw error;
    }
    let entryId: string | undefined;
    if (selector) {
      const resolved = resolveSkillSelector(state.lock, selector);
      if (resolved.status === 'not-found')
        return { status: 'not-found' as const };
      if (resolved.status === 'ambiguous')
        return { status: 'ambiguous' as const, matches: resolved.matches };
      entryId = resolved.entryId;
    }
    const environment = projectedLocalEnvironment(state);
    const agentResults: SkillUpdateAgentResult[] = [];
    for (const agentId of ['codex', 'cursor', 'claude'] as AgentId[]) {
      const detection = await adapters[agentId].detect().catch(() => undefined);
      if (!detection?.installed) continue;
      const plan = await adapters[agentId].planBindings(environment);
      if (!entryId && plan.blocking)
        throw new BindingConflictError(
          `${agentId} has a Skill binding conflict.`,
        );
      const operations = entryId
        ? plan.operations.filter((operation) => operation.entryId === entryId)
        : plan.operations;
      const result = await adapters[agentId].applyBindings(
        { ...plan, operations },
        state.machine.machineId,
      );
      if (result.rolledBack)
        throw new BindingConflictError(
          `${agentId} Skill update failed and was rolled back.`,
        );
      const verifyEnvironment = entryId
        ? {
            ...environment,
            skills: environment.skills.filter((s) => s.entryId === entryId),
          }
        : environment;
      const verification =
        await adapters[agentId].verifyBindings(verifyEnvironment);
      if (!verification.healthy)
        throw new BindingConflictError(
          `${agentId} Skill binding verification failed.`,
        );
      agentResults.push({
        agent: agentId,
        applied: result.applied.length,
        removed: result.removed.length,
        unchanged: result.unchanged,
      });
    }
    return {
      status: 'ok' as const,
      ...(selector ? { selector } : {}),
      ...(entryId ? { entryId } : {}),
      agents: agentResults,
    };
  },
  skillPause: ({ selector }) =>
    setSkillPaused({ stackHome, selector, paused: true }),
  skillResume: ({ selector }) =>
    setSkillPaused({ stackHome, selector, paused: false }),
  // `stak skill check` contacts each checkable Skill's source remote and reports the result to
  // Cloud (P5a §5a). It never approves, installs, pauses, or resumes anything — it only
  // resolves SOURCE and, when different from APPROVED within V0's review bounds, uploads a
  // bounded review artifact for a human to review later on the web. Reporting requires an
  // authenticated Cloud client, so (like `push`/`pull`/`whoami`) a signed-out machine fails
  // closed with `NotAuthenticatedError` rather than silently skipping the report.
  skillCheck: async ({ selector }) => {
    let state;
    try {
      state = await loadMainEnvironment({ stackHome });
    } catch (error) {
      if (
        error instanceof StackStateError &&
        error.code === 'environment-not-found'
      )
        return { checked: [] };
      throw error;
    }
    const credential = await cloudDeps.credentials.read();
    if (!credential) throw new NotAuthenticatedError();
    const baseUrl = resolveCloudBaseUrl({
      env: process.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    const client = createCloudClient({ baseUrl, token: credential.token });
    return runSkillCheck({
      lock: state.lock,
      ...(selector ? { selector } : {}),
      workRoot: path.join(stackHome, 'runtime', 'skill-check'),
      reporter: client,
    });
  },
  // `stak open` — this machine's stable id → the web Overview URL (machine id only). Reading
  // the identity fails clearly on corrupt/ambiguous state; no network call, no mutation.
  machineId: async () =>
    (await getOrCreateMachineIdentity({ stackHome })).machineId,
  openUrl: (machineId) =>
    buildOpenUrl(resolveCloudAppUrl({ env: process.env }), machineId),
  openBrowser: launchBrowser,
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
  reportMachineCheckin: async () => {
    // Best-effort check-in; signed out → nothing to report. Connectivity failures are
    // swallowed by reportCheckin; a 401/403 propagates so a revoked machine is explicit.
    const credential = await cloudDeps.credentials.read();
    if (!credential) return;
    const baseUrl = resolveCloudBaseUrl({
      env: process.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    const client = createCloudClient({ baseUrl, token: credential.token });
    const inputs = await gatherCheckinInputs({
      machine: () => getOrCreateMachineIdentity({ stackHome }),
      // TRUE only when every current native Memory item is byte-identical in the latest
      // backup manifest (never just "a manifest exists"); conservative false otherwise.
      memoryBackedUp: async () => {
        const nativeItems = await (await memoryAdapter()).discover();
        const manifest = await readMemoryManifest(stackHome);
        return nativeMemoryBackedUp(
          nativeItems.map((i) => ({
            logicalId: i.logicalId,
            contentHash: i.contentHash,
          })),
          manifest ? manifest.items : null,
        );
      },
      // Installed skills = what is actually projected into this machine's agent dirs,
      // keyed by the STABLE entry id. From the desired-vs-current status join; missing or
      // uncertain skills are not installed.
      installedSkills: async () => {
        const scanResult = await scanSkills({
          roots: resolveScanRoots({ includeProject: false }),
        });
        const status = await statusMainEnvironment({ stackHome, scanResult });
        return installedSkillsFrom(status.skills);
      },
      // TRUE availability from the Phase 15 resolver (binding OR canonical-Git match),
      // reusing the candidate discovery `stak project` uses. Presence only, no paths.
      projectPresence: async () => {
        const rows = await listProjects({
          stackHome,
          projects: await resolveMemoryProjects({
            cwd: process.cwd(),
            platform: process.platform,
            listDirs: listChildDirs,
            gitOrigin: gitOriginOf,
          }),
        });
        return projectPresenceFrom(rows);
      },
      agentsDetected: async () => {
        const detections = await Promise.all(
          [codex, cursor, claude].map((adapter) =>
            adapter.detect().catch(() => undefined),
          ),
        );
        return detections
          .filter((d): d is AgentDetection => d != null && d.installed)
          .map((d) => d.agent);
      },
    });
    await reportCheckin({ client, inputs });
    // Best-effort P3 project-registry sync: lifecycle + safe identity only, never a path or
    // machine-local binding. Connectivity failures are non-fatal (like check-in); a 401/403
    // from the check-in above already surfaced, so this extra call is swallowed.
    try {
      const rows = await listProjects({
        stackHome,
        projects: await resolveMemoryProjects({
          cwd: process.cwd(),
          platform: process.platform,
          listDirs: listChildDirs,
          gitOrigin: gitOriginOf,
        }),
      });
      const response = await client.syncProjects({
        projects: projectSyncPayloadFrom(rows),
      });
      // Cloud-side Git-canonical reconciliation (never by displayName/path text):
      // adopt the authoritative projectId locally NOW, in this same invocation, so
      // the next backup/check-in never re-sends the just-retired id and recreates the
      // duplicate Cloud refused to create.
      if (response.reconciled && response.reconciled.length > 0) {
        let registry = await readLocalRegistry(stackHome);
        for (const { fromProjectId, toProjectId } of response.reconciled)
          registry = adoptReconciledProjectId(
            registry,
            fromProjectId,
            toProjectId,
          );
        await writeLocalRegistry(stackHome, registry);
      }
    } catch {
      // Non-fatal: the project registry refreshes on the next successful check-in.
    }
  },
};

export const createProgram = (
  dependencies: ProgramDependencies = defaultDependencies,
): Command => {
  const program = new Command()
    .name('stak')
    .description('The control plane for portable AI agent environments.')
    .version(packageMetadata.version);
  // Phase P1: after a state-changing command succeeds, report this machine's state
  // best-effort (no daemon — only on user-run commands). Skipped for commands whose
  // success does not change machine state; a 401/403 propagates (explicit, not offline).
  program.hook('postAction', async (_thisCommand, actionCommand) => {
    if (CHECKIN_COMMANDS.has(actionCommand.name()))
      await dependencies.reportMachineCheckin?.(actionCommand.name());
  });
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
  registerSkillCommand(program, dependencies);
  registerOpenCommand(program, dependencies);
  return program;
};

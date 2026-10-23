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
  applySkillAdd,
  prepareSkillAdd,
  applySkillRemove,
  prepareSkillRemove,
  checkEnvironmentCloudSync,
} from '@stack/core';
import {
  BindingConflictError,
  CodexAdapter,
  CursorAdapter,
  ClaudeAdapter,
  cleanupClaudeTryRuntime,
  cleanupCodexTryRuntime,
  cleanupCursorTryRuntime,
  launchClaudeTryRuntime,
  launchCodexTryRuntime,
  launchCursorTryRuntime,
  prepareClaudeTryRuntime,
  prepareCodexTryRuntime,
  prepareCursorTryRuntime,
  recoverStaleClaudeTryRuntimes,
  recoverStaleCursorTryRuntimes,
  recoverStaleTryRuntimes,
} from '@stack/adapters';
import type { InitializeMainEnvironmentResult } from '@stack/core';
import type {
  RemoteTrialResolution,
  SetSkillPausedResult,
  SkillAddProposal,
  SkillRemoveProposal,
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
import {
  CloudResponseInvalidError,
  LocalEnvironmentConflictError,
  createCloudClient,
  NotAuthenticatedError,
} from '@stack/cloud-client';
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
  canonicalMemoryStatus,
  migrateWithProjectionSeed,
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageCanonicalMemory,
  type CanonicalProjectSummary,
  type CanonicalPullOutcome,
  type UnlocatableProject,
} from './memory/canonical-ops.js';
import { stageMemoryWithProjectDedup } from './memory/stage-memory.js';
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

import { registerAddCommand } from './commands/add.js';
import type {
  CloudSyncDisplayState,
  MemoryCloudDisplayState,
} from './ui/environment.js';
import { computeMemoryWorkingTreeStatus } from './memory/working-tree-status.js';
import type { MemoryWorkingTreeStatus } from './memory/working-tree-status.js';
import { registerDiffCommand } from './commands/diff.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerStatusCommand } from './commands/status.js';
import { registerRunCommand } from './commands/run.js';
import {
  registerUseCommand,
  type UseBootstrapPreview,
} from './commands/use.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerTryCommand } from './commands/try.js';
import { registerLoginCommand } from './commands/login.js';
import { registerLogoutCommand } from './commands/logout.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import {
  registerPushCommand,
  type MemoryPushPreflight,
} from './commands/push.js';
import type { MemoryPushOutcome } from './ui/cloud.js';
import {
  registerPullCommand,
  type MemoryPullPreflight,
} from './commands/pull.js';
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
  setProjectDisplayName,
  setProjectLifecycle,
  type MapProjectResult,
  type ProjectListRow,
  type SetLifecycleResult,
  type SetProjectNameResult,
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
  checkCloud?(): Promise<CloudSyncDisplayState>;
  checkMemory?(): Promise<MemoryWorkingTreeStatus>;
  checkMemoryCloud?(): Promise<MemoryCloudDisplayState>;
  diff(scanResult: ScanResult): Promise<EnvironmentDiff>;
  prepareAdd(
    scanResult: ScanResult,
    selectors: string[] | '.',
  ): Promise<SkillAddProposal>;
  applyAdd(proposal: SkillAddProposal): Promise<unknown>;
  stageMemory?(): Promise<{ files: number; projects: number }>;
  prepareUse(
    input: string,
    options: { dryRun: boolean },
  ): Promise<
    | StackUseProposal
    | StackRemoteUseProposal
    | StackOwnedUseProposal
    | UseBootstrapPreview
  >;
  applyUse(
    proposal:
      | StackUseProposal
      | StackRemoteUseProposal
      | StackOwnedUseProposal
      | UseBootstrapPreview,
  ): Promise<unknown>;
  prepareRemove(
    identifier: string,
  ): Promise<StackRemoveProposal | SkillRemoveProposal>;
  applyRemove(
    proposal: StackRemoveProposal | SkillRemoveProposal,
  ): Promise<unknown>;
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
  detectAgent(agent: AgentId): Promise<AgentDetection>;
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
    agent: AgentId,
    trial: TrialStackResolution | RemoteTrialResolution,
  ): Promise<TryPreparationResult>;
  cleanupTry(agent: AgentId, preparation: TryPreparationResult): Promise<void>;
  launchTry(
    agent: AgentId,
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
  memoryPushPreflight?(): Promise<MemoryPushPreflight>;
  applyMemoryPush?(): Promise<MemoryPushOutcome>;
  cloudPreparePull(): Promise<PullPlan>;
  cloudApplyPull(plan: PullPlan): Promise<ApplyPullResult>;
  memoryPullPreflight?(): Promise<MemoryPullPreflight>;
  applyMemoryPull?(): Promise<CloudRecoverOutcome>;
  applyCanonicalPull?(): Promise<CanonicalPullOutcome>;
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
  projectSetName(options: {
    project: string;
    name: string;
  }): Promise<SetProjectNameResult>;
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

const memoryDiscoveryOptions = async () => ({
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

const memoryAdapter = async () =>
  createClaudeMemoryAdapter(await memoryDiscoveryOptions());

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
  let fetchProjectNames: MemoryCloudDeps['fetchProjectNames'];
  if (credential) {
    const baseUrl = resolveCloudBaseUrl({
      env: process.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    const cloudClient = createCloudClient({ baseUrl, token: credential.token });
    backend = stackCloudRemoteMemoryBackend(cloudClient);
    // Read-only; seeds a recovered Project's Cloud-known display name locally right
    // after `memory recover` (never read from the Memory bundle — see
    // `seedRecoveredProjectNames`).
    fetchProjectNames = async () =>
      (await cloudClient.getProjects()).projects.map((p) => ({
        projectId: p.projectId,
        ...(p.name !== undefined ? { name: p.name } : {}),
      }));
  }
  return {
    stackHome,
    backend,
    localKeyStore: fileLocalMemoryKeyStore(stackHome),
    runLocalBackup: async () => (await memoryAdapter()).backup(),
    ...(fetchProjectNames ? { fetchProjectNames } : {}),
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
    ...(base.fetchProjectNames
      ? { fetchProjectNames: base.fetchProjectNames }
      : {}),
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

const isBootstrapPreview = (
  proposal:
    | StackUseProposal
    | StackRemoteUseProposal
    | StackOwnedUseProposal
    | UseBootstrapPreview,
): proposal is UseBootstrapPreview =>
  'kind' in proposal && proposal.kind === 'bootstrap-preview';

/** Narrows away `UseBootstrapPreview` — it is a `--dry-run`-only preview the command
 *  layer always returns early on, so it should never reach `applyUse` for real. */
const assertNotBootstrapPreview = (
  proposal:
    | StackUseProposal
    | StackRemoteUseProposal
    | StackOwnedUseProposal
    | UseBootstrapPreview,
): StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal => {
  if (isBootstrapPreview(proposal))
    throw new Error('A bootstrap preview cannot be applied.');
  return proposal;
};

/**
 * Fresh-machine `use` onboarding: a genuinely new machine with zero global Skills
 * should not need to understand `main`/`stak init` before consuming its first STAK.
 * If `main` is missing AND the same safe discovery `init`/`scan` already use finds
 * zero valid Skills, bootstrap an empty `main` so the requested `use` can proceed —
 * works identically for a public (@owner/name), the caller's own Cloud-named, or a
 * local STAK. If `main` is missing but ONE OR MORE Skills ARE discovered, this does
 * NOT bootstrap (preserves the existing safety boundary: those Skills must be
 * captured intentionally via an explicit `stak init`) — the original
 * "main does not exist. Run stak init first." error still surfaces unchanged.
 * A no-op (zero extra writes) whenever `main` already exists.
 *
 * `dryRun: true` never writes anything, even when bootstrap conditions are met —
 * `--dry-run` promises no persistent mutation. It returns `'preview'` instead so the
 * caller can render an accurate preview without a real environment to diff against.
 */
export const bootstrapEmptyMainIfSkillFree = async (options: {
  stackHome: string;
  dryRun: boolean;
}): Promise<'bootstrapped' | 'preview' | 'skipped'> => {
  try {
    await loadMainEnvironment({ stackHome: options.stackHome });
    return 'skipped'; // main already exists — never touch it here
  } catch (error) {
    if (!(
      error instanceof StackStateError && error.code === 'environment-not-found'
    ))
      throw error;
  }
  const scanResult = await scanSkills({
    roots: resolveScanRoots({ includeProject: false }),
  });
  if (scanResult.skills.length > 0) return 'skipped'; // existing safety error surfaces
  if (options.dryRun) return 'preview';
  await initializeMainEnvironment({ stackHome: options.stackHome, scanResult });
  return 'bootstrapped';
};

/**
 * The postAction check-in hook (below) needs a global (non-project) ScanResult to compute
 * `installedSkills`, and several CHECKIN_COMMANDS (`scan`, `status`, …) already perform that
 * exact same scan — same roots, same process, moments earlier — as part of their own action.
 * Re-scanning from disk a second time would redo the expensive hashing/Git-provenance work for
 * nothing new, so the global scan result is cached here within this single CLI invocation and
 * reused by the check-in if still fresh. It is never read across process invocations.
 */
let lastGlobalScan: { result: ScanResult } | undefined;

const defaultDependencies: ProgramDependencies = {
  scan: async ({ project }) => {
    const result = await scanSkills({
      roots: resolveScanRoots({ includeProject: project }),
    });
    if (!project) lastGlobalScan = { result };
    return result;
  },
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
  // Cheap (metadata-only) Cloud ahead/behind check for `stak status`. Never throws: any
  // failure (not signed in, offline, Cloud error) resolves to a degraded display state so
  // status always succeeds locally regardless of Cloud reachability — it never fetches a
  // bundle or snapshot, the same `getEnvironment` call push/pull already make for conflict
  // checks. A data/compatibility problem (`CloudResponseInvalidError` — reached Cloud, got
  // a response, couldn't read it) is reported distinctly from a genuine network failure:
  // collapsing both into "offline" would be misleading when the network is fine.
  checkCloud: async (): Promise<CloudSyncDisplayState> => {
    let client;
    try {
      client = await authenticatedClient(cloudDeps);
    } catch {
      return { status: 'not-checked', reason: 'unauthenticated' };
    }
    try {
      return await checkEnvironmentCloudSync({ stackHome, client });
    } catch (error) {
      if (error instanceof CloudResponseInvalidError)
        return { status: 'unavailable' };
      return { status: 'not-checked', reason: 'offline' };
    }
  },
  // MACHINE (native Memory) vs MAIN (the staged local manifest) — read-only, no Cloud
  // call, never mutates. Reuses the same scan `stak memory scan` uses and the same
  // comparison `runMemoryBackup` itself would make; never duplicates scanning/manifest
  // construction.
  checkMemory: async (): Promise<
    MemoryWorkingTreeStatus & {
      canonicalProjects: CanonicalProjectSummary[];
      newProjects: number;
      conflictedProjects: number;
      unlocatableProjects: UnlocatableProject[];
      untrackedFolders: number;
      upgradePending: boolean;
    }
  > => {
    // Project-scope Memory is canonical Memory's job now (Step 1 of this feature) —
    // the v1 manifest only ever contains global items post-migration, so this
    // MACHINE-vs-MAIN comparison must only ever compare global items too. Comparing
    // unfiltered native items here would show every project-scope item as a
    // permanent, un-clearable "change not added".
    const nativeItems = (await (await memoryAdapter()).discover()).filter(
      (item) => item.scope === 'global',
    );
    const registry = await readLocalRegistry(stackHome);
    const status = await computeMemoryWorkingTreeStatus({ stackHome, nativeItems, registry });
    // Canonical (Project) Memory status, additive to the MACHINE-vs-MAIN check above.
    // Never let a canonical status failure break `stak status` — same defensive
    // wrapping convention as `checkCloud`/`checkMemoryCloud` just above.
    const canonicalStatus = await canonicalMemoryStatus(
      stackHome,
      await memoryDiscoveryOptions(),
    ).catch(() => ({
      projects: [] as CanonicalProjectSummary[],
      newProjects: 0,
      conflictedProjects: 0,
      unlocatableProjects: [] as UnlocatableProject[],
      untrackedFolders: 0,
      upgradePending: false,
    }));
    return {
      ...status,
      canonicalProjects: canonicalStatus.projects,
      newProjects: canonicalStatus.newProjects,
      conflictedProjects: canonicalStatus.conflictedProjects,
      unlocatableProjects: canonicalStatus.unlocatableProjects,
      untrackedFolders: canonicalStatus.untrackedFolders,
      upgradePending: canonicalStatus.upgradePending,
    };
  },
  // Deliberately narrow (see MemoryCloudDisplayState): only "does a Cloud backup exist
  // at all", reusing the existing readMemoryCloudStatus check — never a new subsystem,
  // never claims Memory is "up to date" (that would overclaim what's cheaply knowable).
  checkMemoryCloud: async (): Promise<MemoryCloudDisplayState> => {
    try {
      const status = await readMemoryCloudStatus(await buildMemoryCloudDeps());
      if (!status.authenticated || status.latestGeneration === null)
        return status.authenticated ? { status: 'no-backup' } : { status: 'not-checked' };
      return {
        status: 'backed-up',
        generation: status.latestGeneration,
        historicalRecovery: status.historicalRecovery,
      };
    } catch {
      return { status: 'not-checked' };
    }
  },
  diff: async (scanResult) => diffMainEnvironment({ stackHome, scanResult }),
  prepareAdd: async (scanResult, selectors) =>
    prepareSkillAdd({ stackHome, scanResult, selectors }),
  applyAdd: (proposal) => applySkillAdd(proposal),
  // Local-only, never reaches Cloud — `stak add .` only ever stages into the local
  // Memory manifest (and, via its registry sync, local portable Project state).
  // Mirrors `stak memory backup`'s own discovery/composition/commit exactly, with one
  // addition: native discoveries are normalized through the stable Project registry
  // first, so a relocated/re-cloned project's stale-but-still-discovered old directory
  // never creates a second manifest record for Memory that already has one.
  stageMemory: async () => {
    const discovery = await memoryDiscoveryOptions();
    const legacy = await stageMemoryWithProjectDedup(discovery);
    const canonical = await stageCanonicalMemory(stackHome, discovery);
    return {
      files: legacy.files,
      projects: legacy.projects,
      canonical: canonical.projects.map((p) => ({
        projectId: p.projectId,
        imported: p.imported.length,
        conflicts: p.conflicts.length + p.sourceConflicts.length,
        guarded: p.guardedPaths.length,
      })),
      conflictedProjects: canonical.conflictedProjects,
      unlocatableProjects: canonical.unlocatableProjects,
      untrackedFolders: canonical.untrackedFolders,
    };
  },
  prepareUse: async (input, options) => {
    const bootstrap = await bootstrapEmptyMainIfSkillFree({
      stackHome,
      dryRun: options.dryRun,
    });
    if (bootstrap === 'preview')
      return { kind: 'bootstrap-preview' as const, stak: input };
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
  applyUse: async (proposal) => {
    // The command layer always returns early on a bootstrap preview (--dry-run only;
    // no environment exists yet) — it is never actually applied.
    const real = assertNotBootstrapPreview(proposal);
    if (isOwnedUseProposal(real))
      return applyOwnedStackUse(real, { gitExecutor: spawnGit });
    if (isRemoteUseProposal(real))
      return applyRemoteStackUse(real, {
        gitExecutor: spawnGit,
        client: await publicReadClient(cloudDeps),
      });
    return applyStackUse(real);
  },
  prepareRemove: async (identifier) => {
    try {
      return await prepareStackRemove({ stackHome, identifier });
    } catch (error) {
      // Fall back to a direct Skill only when no STAK layer matches at all — any other
      // error (ambiguous layer match, etc.) must surface as-is, never masked.
      if (
        !(
          error instanceof StackCompositionError &&
          error.code === 'stack-layer-not-found'
        )
      )
        throw error;
      return prepareSkillRemove({ stackHome, selector: identifier });
    }
  },
  applyRemove: (proposal) =>
    'layer' in proposal
      ? applyStackRemove(proposal)
      : applySkillRemove(proposal),
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
  prepareTry: async (agent, trial) => {
    // Conservatively retry any prior runtimes left in cleanup-failed before
    // creating a new one (best-effort; never blocks the trial).
    const recover =
      agent === 'claude'
        ? recoverStaleClaudeTryRuntimes
        : agent === 'cursor'
          ? recoverStaleCursorTryRuntimes
          : recoverStaleTryRuntimes;
    await recover({ stackHome }).catch(() => undefined);
    const prepare =
      agent === 'claude'
        ? prepareClaudeTryRuntime
        : agent === 'cursor'
          ? prepareCursorTryRuntime
          : prepareCodexTryRuntime;
    return prepare({
      stackHome,
      trial: trial.resolved,
      homeDir: os.homedir(),
      env: process.env,
    });
  },
  cleanupTry: async (agent, preparation) => {
    const cleanup =
      agent === 'claude'
        ? cleanupClaudeTryRuntime
        : agent === 'cursor'
          ? cleanupCursorTryRuntime
          : cleanupCodexTryRuntime;
    await cleanup({ stackHome, session: preparation.session });
  },
  launchTry: (agent, preparation, detection) => {
    const launch =
      agent === 'claude'
        ? launchClaudeTryRuntime
        : agent === 'cursor'
          ? launchCursorTryRuntime
          : launchCodexTryRuntime;
    return launch({ stackHome, preparation, detection });
  },
  cloudLogin: (options) => performLogin(cloudDeps, options),
  cloudLogout: () => performLogout(cloudDeps),
  cloudWhoami: () => performWhoami(cloudDeps),
  cloudPreparePush: () => cloudPreparePush(cloudDeps),
  cloudApplyPush: (plan) => cloudApplyPush(cloudDeps, plan),
  cloudPreparePull: () => cloudPreparePull(cloudDeps),
  cloudApplyPull: (plan) => cloudApplyPull(cloudDeps, plan),
  // Unified push (P3): Memory rides along with Skills, but push uploads ONLY what
  // `stak add .` already staged into the local manifest — it never rescans native Memory
  // or re-stages it itself (that would make push an implicit `add .`, which the locked
  // MACHINE -> add -> MAIN -> push -> CLOUD model forbids). Contrast with `stak memory
  // backup` (`memoryCloudBackup` below), which intentionally still does its own local
  // rescan first — that command's own behavior is unchanged.
  memoryPushPreflight: async () => {
    const status = await readMemoryCloudStatus(await buildMemoryCloudDeps());
    return status.historicalRecovery
      ? {
          blocked: true,
          reason:
            'Local Memory was recovered from an older STAK Cloud generation than the current latest. Run `stak memory recover` to catch up before pushing, or `stak memory backup` to accept the historical state deliberately.',
        }
      : { blocked: false };
  },
  // `stak push` means "synchronize MAIN to Cloud" — if staged MAIN already equals the
  // latest Cloud generation, this must be a no-op: it never creates another immutable
  // generation containing identical state (unlike the explicit `stak memory backup`,
  // which intentionally always creates one — see `memoryCloudBackup` below, unchanged).
  // Task 13: this REPLACES the old `resolveMemoryPushState`/`pushStagedMemory` call
  // site with the canonical-Memory engine (`pushMemoryViaCanonical`) — there is
  // exactly one `createGeneration` call per `stak push` now, carrying both the global
  // v1 manifest and canonical Project Memory together in a single v2 bundle.
  applyMemoryPush: async () => {
    const deps = await buildMemoryCloudDeps();
    const outcome = await pushMemoryViaCanonical(deps, await memoryDiscoveryOptions());
    if (outcome.status === 'conflict')
      throw new LocalEnvironmentConflictError(
        `Memory has ${outcome.conflicts?.length ?? 0} unresolved conflict(s). Resolve with \`stak memory resolve\`, then push again.`,
      );
    if (outcome.status === 'retry-exhausted')
      throw new StackCompositionError(
        'memory-push-retry-exhausted',
        'STAK Cloud kept moving while pushing Memory. Try again.',
      );
    if (outcome.status === 'protected-locked') return { status: 'protected-locked' };
    if (outcome.status === 'nothing-staged') return { status: 'nothing-staged' };
    if (outcome.status === 'skipped') return { status: 'skipped' };
    // Task 13 Important-5: never silently drop unlocatable projects or native
    // materialize conflicts the canonical engine already surfaced.
    const extras = {
      ...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}),
      ...(outcome.conflicts ? { materializeConflicts: outcome.conflicts } : {}),
    };
    return outcome.status === 'up-to-date'
      ? { status: 'up-to-date', generation: outcome.generation ?? 0, ...extras }
      : { status: 'standard', generation: outcome.generation ?? 0, ...extras };
  },
  // Unified pull (P3): Memory only auto-recovers on a genuinely fresh machine (no local
  // manifest yet) — an established machine's Memory is never silently overwritten here;
  // `stak memory recover` remains the explicit, deliberate path.
  memoryPullPreflight: async () =>
    (await readMemoryManifest(stackHome))
      ? {
          eligible: false,
          reason: 'Local Memory already exists on this machine.',
        }
      : { eligible: true },
  applyMemoryPull: async () => runMemoryCloudRecover(await buildMemoryCloudDeps()),
  // Task 13: canonical (Project) Memory's own pull — additive, runs on every `stak
  // pull` regardless of `memoryPullPreflight` (which only gates the legacy
  // fresh-machine full-recover path above). Never publishes.
  applyCanonicalPull: async () =>
    pullMemoryViaCanonical(await buildMemoryCloudDeps(), await memoryDiscoveryOptions()),
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
  // Task 13 fix round 3 (finding C): migrate with the same projection-seeding
  // locator push/pull use, so `stak memory backup` run first seeds identically.
  memoryCloudBackup: async () => {
    const discovery = await memoryDiscoveryOptions();
    return runMemoryCloudBackup(await buildMemoryCloudDeps(), {
      migrate: (home) => migrateWithProjectionSeed(home, discovery),
    });
  },
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
  // Machine-local write only; propagates to Cloud through the normal discovery-sync
  // postAction hook (`name` is in CHECKIN_COMMANDS), the same path a discovery-time
  // name already uses — no separate Cloud call needed here.
  projectSetName: async ({ project, name }) =>
    setProjectDisplayName({ stackHome, selector: project, name }),
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
    // `listProjects`/`resolveMemoryProjects` (which shells out to Git per candidate project
    // directory for origin detection) is needed both for the check-in's `projectPresence`
    // field and for the project-registry sync below. Compute it once and share it — the two
    // call sites previously ran this independently, paying the Git-subprocess cost twice.
    const projectRows = await listProjects({
      stackHome,
      projects: await resolveMemoryProjects({
        cwd: process.cwd(),
        platform: process.platform,
        listDirs: listChildDirs,
        gitOrigin: gitOriginOf,
      }),
    });
    const inputs = await gatherCheckinInputs({
      machine: () => getOrCreateMachineIdentity({ stackHome }),
      // TRUE only when every current native Memory item is byte-identical in the latest
      // backup manifest (never just "a manifest exists"); conservative false otherwise.
      memoryBackedUp: async () => {
        // The v1 manifest only ever holds global items post-migration (project-scope
        // Memory is canonical Memory's job now) — compare only global native items
        // against it, or every project item would permanently read as "not backed up".
        const nativeItems = (await (await memoryAdapter()).discover()).filter(
          (item) => item.scope === 'global',
        );
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
        const scanResult =
          lastGlobalScan?.result ??
          (await scanSkills({
            roots: resolveScanRoots({ includeProject: false }),
          }));
        const status = await statusMainEnvironment({ stackHome, scanResult });
        return installedSkillsFrom(status.skills);
      },
      // TRUE availability from the Phase 15 resolver (binding OR canonical-Git match),
      // reusing the candidate discovery `stak project` uses. Presence only, no paths.
      projectPresence: async () => projectPresenceFrom(projectRows),
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
    // The check-in and the project-registry sync are independent network calls to the same
    // Cloud API, so they run concurrently rather than paying two sequential round trips.
    // Connectivity failures in the sync are non-fatal (like check-in) and swallowed inline; a
    // 401/403 from the check-in itself still propagates via `Promise.all` so a revoked
    // machine remains explicit.
    const [, response] = await Promise.all([
      reportCheckin({ client, inputs }),
      (async () => {
        try {
          return await client.syncProjects({
            projects: projectSyncPayloadFrom(projectRows),
          });
        } catch {
          return undefined;
        }
      })(),
    ]);
    // Best-effort P3 project-registry sync: lifecycle + safe identity only, never a path or
    // machine-local binding.
    try {
      // Cloud-side Git-canonical reconciliation (never by displayName/path text):
      // adopt the authoritative projectId locally NOW, in this same invocation, so
      // the next backup/check-in never re-sends the just-retired id and recreates the
      // duplicate Cloud refused to create.
      if (response?.reconciled && response.reconciled.length > 0) {
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
  registerAddCommand(program, dependencies);
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

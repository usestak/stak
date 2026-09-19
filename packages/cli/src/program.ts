import { createRequire } from 'node:module';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import {
  diffMainEnvironment,
  applyStackRemove,
  applyStackUse,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareStackRemove,
  prepareStackUse,
  resolveStackHome,
  statusMainEnvironment,
} from '@stack/core';
import { CodexAdapter } from '@stack/adapters';
import type { InitializeMainEnvironmentResult } from '@stack/core';
import type { StackRemoveProposal, StackUseProposal } from '@stack/core';
import { resolveScanRoots, scanSkills } from '@stack/scanner';
import type {
  AgentDetection,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  EnvironmentDiff,
  EnvironmentStatus,
  LaunchResult,
  ResolvedLocalEnvironment,
  ScanResult,
} from '@stack/spec';

import { registerDiffCommand } from './commands/diff.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerStatusCommand } from './commands/status.js';
import { registerRunCommand } from './commands/run.js';
import { registerUseCommand } from './commands/use.js';
import { registerRemoveCommand } from './commands/remove.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

export type ProgramDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  initialize(scanResult: ScanResult): Promise<InitializeMainEnvironmentResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  diff(scanResult: ScanResult): Promise<EnvironmentDiff>;
  prepareUse(input: string): Promise<StackUseProposal>;
  applyUse(proposal: StackUseProposal): Promise<unknown>;
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
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const stackHome = resolveStackHome();
const codex = new CodexAdapter({ stackHome, homeDir: os.homedir() });
const defaultDependencies: ProgramDependencies = {
  scan: async ({ project }) =>
    scanSkills({ roots: resolveScanRoots({ includeProject: project }) }),
  initialize: async (scanResult) =>
    initializeMainEnvironment({ stackHome, scanResult }),
  status: async (scanResult) =>
    statusMainEnvironment({ stackHome, scanResult }),
  diff: async (scanResult) => diffMainEnvironment({ stackHome, scanResult }),
  prepareUse: (input) => prepareStackUse({ stackHome, input }),
  applyUse: (proposal) => applyStackUse(proposal),
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
  return program;
};

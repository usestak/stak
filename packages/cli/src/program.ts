import { createRequire } from 'node:module';

import { Command } from 'commander';

import {
  diffMainEnvironment,
  initializeMainEnvironment,
  resolveStackHome,
  statusMainEnvironment,
} from '@stack/core';
import type { InitializeMainEnvironmentResult } from '@stack/core';
import { resolveScanRoots, scanSkills } from '@stack/scanner';
import type {
  EnvironmentDiff,
  EnvironmentStatus,
  ScanResult,
} from '@stack/spec';

import { registerDiffCommand } from './commands/diff.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerStatusCommand } from './commands/status.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

export type ProgramDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  initialize(scanResult: ScanResult): Promise<InitializeMainEnvironmentResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  diff(scanResult: ScanResult): Promise<EnvironmentDiff>;
  writeOut(value: string): void;
};

const defaultDependencies: ProgramDependencies = {
  scan: async ({ project }) =>
    scanSkills({ roots: resolveScanRoots({ includeProject: project }) }),
  initialize: async (scanResult) =>
    initializeMainEnvironment({ stackHome: resolveStackHome(), scanResult }),
  status: async (scanResult) =>
    statusMainEnvironment({ stackHome: resolveStackHome(), scanResult }),
  diff: async (scanResult) =>
    diffMainEnvironment({ stackHome: resolveStackHome(), scanResult }),
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
  return program;
};

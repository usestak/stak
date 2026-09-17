import { createRequire } from 'node:module';

import { Command } from 'commander';

import { resolveScanRoots, scanSkills } from '@stack/scanner';
import type { ScanResult } from '@stack/spec';

import { registerScanCommand } from './commands/scan.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

export type ProgramDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  writeOut(value: string): void;
};

const defaultDependencies: ProgramDependencies = {
  scan: async ({ project }) =>
    scanSkills({ roots: resolveScanRoots({ includeProject: project }) }),
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
  return program;
};

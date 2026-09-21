import type { Command } from 'commander';

import type { InitializeMainEnvironmentResult } from '@stack/core';
import type { ScanResult } from '@stack/spec';

import { renderInitResult } from '../ui/environment.js';

export type InitCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  initialize(scanResult: ScanResult): Promise<InitializeMainEnvironmentResult>;
  writeOut(value: string): void;
};

export const registerInitCommand = (
  program: Command,
  dependencies: InitCommandDependencies,
): void => {
  program
    .command('init')
    .description('Create main from currently discovered global Skills')
    .option('--verbose', 'show detailed import diagnostics')
    .action(async (options: { verbose?: boolean }) => {
      const result = await dependencies.initialize(
        await dependencies.scan({ project: false }),
      );
      dependencies.writeOut(
        renderInitResult(result, { verbose: options.verbose === true }),
      );
    });
};

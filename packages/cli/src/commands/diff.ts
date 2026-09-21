import type { Command } from 'commander';

import type { EnvironmentDiff, ScanResult } from '@stack/spec';

import { renderDiff } from '../ui/environment.js';

export type DiffCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  diff(scanResult: ScanResult): Promise<EnvironmentDiff>;
  writeOut(value: string): void;
};

export const registerDiffCommand = (
  program: Command,
  dependencies: DiffCommandDependencies,
): void => {
  program
    .command('diff')
    .description('Show what changed from the desired main Stack')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detailed per-Skill differences')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const result = await dependencies.diff(
        await dependencies.scan({ project: false }),
      );
      dependencies.writeOut(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderDiff(result, { verbose: options.verbose === true }),
      );
    });
};

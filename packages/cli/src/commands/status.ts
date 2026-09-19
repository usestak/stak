import type { Command } from 'commander';

import type { EnvironmentStatus, ScanResult } from '@stack/spec';

import { renderStatus } from '../ui/environment.js';

export type StatusCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  writeOut(value: string): void;
};

export const registerStatusCommand = (
  program: Command,
  dependencies: StatusCommandDependencies,
): void => {
  program
    .command('status')
    .description('Compare this Machine with the desired main Environment')
    .option('--json', 'emit structured JSON only')
    .action(async (options: { json?: boolean }) => {
      const result = await dependencies.status(
        await dependencies.scan({ project: false }),
      );
      dependencies.writeOut(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderStatus(result),
      );
    });
};

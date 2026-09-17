import type { Command } from 'commander';

import type { ScanResult } from '@stack/spec';

import { renderScanResult } from '../ui/scan.js';

export type ScanCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  writeOut(value: string): void;
};

export const registerScanCommand = (
  program: Command,
  dependencies: ScanCommandDependencies,
): void => {
  program
    .command('scan')
    .description('Discover installed Agent Skills without making changes')
    .option('--json', 'emit structured JSON only')
    .option('--project', 'include Skill roots in the current project')
    .action(async (options: { json?: boolean; project?: boolean }) => {
      const result = await dependencies.scan({
        project: options.project === true,
      });
      dependencies.writeOut(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderScanResult(result),
      );
    });
};

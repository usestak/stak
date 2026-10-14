import type { Command } from 'commander';

import type { EnvironmentStatus, ScanResult } from '@stack/spec';

import { renderStatus, type AgentReadiness } from '../ui/environment.js';

export type StatusCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  detectAgents?(): Promise<AgentReadiness[]>;
  writeOut(value: string): void;
};

export const registerStatusCommand = (
  program: Command,
  dependencies: StatusCommandDependencies,
): void => {
  program
    .command('status')
    .description('Show whether your STAK is ready on this machine')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detailed internal state')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const result = await dependencies.status(
        await dependencies.scan({ project: false }),
      );
      if (options.json) {
        dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const agents =
        !options.verbose && dependencies.detectAgents
          ? await dependencies.detectAgents().catch(() => [])
          : [];
      dependencies.writeOut(
        renderStatus(result, {
          verbose: options.verbose === true,
          ...(agents.length > 0 ? { agents } : {}),
        }),
      );
    });
};

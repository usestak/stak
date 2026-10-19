import type { Command } from 'commander';

import type { EnvironmentStatus, ScanResult } from '@stack/spec';

import type { MemoryWorkingTreeStatus } from '../memory/working-tree-status.js';
import {
  renderStatus,
  type AgentReadiness,
  type CloudSyncDisplayState,
  type MemoryCloudDisplayState,
} from '../ui/environment.js';

export type StatusCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  status(scanResult: ScanResult): Promise<EnvironmentStatus>;
  detectAgents?(): Promise<AgentReadiness[]>;
  /**
   * Cheap (metadata-only, no snapshot download) Cloud ahead/behind check. MUST never
   * throw — offline/unauthenticated/any failure resolves to a `not-checked` state so
   * `stak status` always succeeds locally regardless of Cloud reachability.
   */
  checkCloud?(): Promise<CloudSyncDisplayState>;
  /**
   * MACHINE (native Memory) vs MAIN (the staged local manifest) — read-only, no Cloud
   * call, never mutates. MUST never throw for the same reason as `checkCloud`.
   */
  checkMemory?(): Promise<MemoryWorkingTreeStatus>;
  /** Whether Memory has ever reached Cloud at all — deliberately not an "up to date"
   * claim (see `MemoryCloudDisplayState`). MUST never throw. */
  checkMemoryCloud?(): Promise<MemoryCloudDisplayState>;
  writeOut(value: string): void;
};

export const registerStatusCommand = (
  program: Command,
  dependencies: StatusCommandDependencies,
): void => {
  program
    .command('status')
    .description(
      'Show machine vs. main vs. STAK Cloud: untracked/modified/missing Skills and sync state',
    )
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detailed internal state')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const result = await dependencies.status(
        await dependencies.scan({ project: false }),
      );
      const cloud = dependencies.checkCloud
        ? await dependencies.checkCloud().catch(
            () => ({ status: 'not-checked', reason: 'offline' }) as const,
          )
        : undefined;
      const memory = dependencies.checkMemory
        ? await dependencies.checkMemory().catch(() => undefined)
        : undefined;
      const memoryCloud = dependencies.checkMemoryCloud
        ? await dependencies
            .checkMemoryCloud()
            .catch(() => ({ status: 'not-checked' }) as const)
        : undefined;
      if (options.json) {
        dependencies.writeOut(
          `${JSON.stringify(
            {
              ...result,
              ...(cloud ? { cloud } : {}),
              ...(memory ? { memory } : {}),
              ...(memoryCloud ? { memoryCloud } : {}),
            },
            null,
            2,
          )}\n`,
        );
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
          ...(cloud ? { cloud } : {}),
          ...(memory ? { memory } : {}),
          ...(memoryCloud ? { memoryCloud } : {}),
        }),
      );
    });
};

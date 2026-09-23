import type { Command } from 'commander';

import type {
  BackupResult,
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
} from '@stack/memory';
import { toManifestItem } from '@stack/memory';

import {
  renderMemoryBackup,
  renderMemoryRestore,
  renderMemoryScan,
  renderMemoryStatus,
} from '../ui/memory.js';

export type MemoryCommandDependencies = {
  memoryScan(): Promise<DiscoveredMemoryItem[]>;
  memoryBackup(): Promise<BackupResult>;
  memoryStatus(): Promise<MemoryStatus | null>;
  memoryRestore(options: { apply: boolean }): Promise<RestorePlan>;
  writeOut(value: string): void;
};

type Flags = { json?: boolean; verbose?: boolean; dryRun?: boolean };

const emitJson = (deps: MemoryCommandDependencies, value: unknown) =>
  deps.writeOut(`${JSON.stringify(value, null, 2)}\n`);

export const registerMemoryCommand = (
  program: Command,
  dependencies: MemoryCommandDependencies,
): void => {
  const memory = program
    .command('memory')
    .description('Back up and restore private agent memory (Claude)');

  memory
    .command('scan')
    .description('Discover portable agent memory on this machine (read-only)')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show per-item diagnostics')
    .action(async (options: Flags) => {
      const items = await dependencies.memoryScan();
      if (options.json) {
        // Portable projection only — never absolute paths.
        emitJson(dependencies, {
          provider: 'claude',
          files: items.length,
          items: items.map(toManifestItem),
        });
        return;
      }
      dependencies.writeOut(
        renderMemoryScan(items, { verbose: options.verbose === true }),
      );
    });

  memory
    .command('backup')
    .description(
      'Copy private memory into Stack’s private store (read-only capture)',
    )
    .option('--json', 'emit structured JSON only')
    .action(async (options: Flags) => {
      dependencies.writeOut('Backing up Claude memory...\n\n');
      const result = await dependencies.memoryBackup();
      if (options.json) {
        emitJson(dependencies, result);
        return;
      }
      dependencies.writeOut(renderMemoryBackup(result));
    });

  memory
    .command('status')
    .description('Show the last memory backup')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detail')
    .action(async (options: Flags) => {
      const status = await dependencies.memoryStatus();
      if (options.json) {
        emitJson(dependencies, status ?? { provider: 'claude', files: 0 });
        return;
      }
      dependencies.writeOut(
        renderMemoryStatus(status, { verbose: options.verbose === true }),
      );
    });

  memory
    .command('restore')
    .description('Restore private memory from Stack’s private store')
    .option('--dry-run', 'preview without changing agent memory')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show per-item detail')
    .action(async (options: Flags) => {
      const dryRun = options.dryRun === true;
      const plan = await dependencies.memoryRestore({ apply: !dryRun });
      if (options.json) {
        emitJson(dependencies, {
          provider: plan.provider,
          files: plan.files,
          projects: plan.projects,
          items: plan.items.map((item) => ({
            logicalId: item.logicalId,
            kind: item.kind,
            scope: item.scope,
            status: item.status,
          })),
        });
        return;
      }
      dependencies.writeOut(
        renderMemoryRestore(plan, {
          dryRun,
          verbose: options.verbose === true,
        }),
      );
    });
};

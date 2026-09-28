import type { Command } from 'commander';

import type {
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
} from '@stack/memory';
import { toManifestItem } from '@stack/memory';

import type {
  CloudRecoverOutcome,
  MemoryBackupOutcome,
  MemoryCloudStatus,
} from '../memory/cloud-ops.js';
import {
  renderMemoryBackupPreview,
  renderMemoryCloudBackup,
  renderMemoryCloudStatus,
  renderMemoryProtect,
  renderMemoryRecover,
  renderMemoryRestore,
  renderMemoryScan,
  type MemoryBackupPreview,
} from '../ui/memory.js';

export type MemoryProtectCommandResult =
  | { migrated: number; recoveryFilePath?: string }
  | { status: 'not-authenticated' }
  | { status: 'insecure-local-key' };

const INSECURE_LOCAL_KEY_MESSAGE =
  'Could not secure local Memory key storage on this device.\n' +
  'Protected Memory was not enabled.\n' +
  'Check the permissions on your Stack home directory and try again.\n';

export type MemoryCommandDependencies = {
  memoryScan(): Promise<DiscoveredMemoryItem[]>;
  memoryStatus(): Promise<MemoryStatus | null>;
  memoryRestore(options: { apply: boolean }): Promise<RestorePlan>;
  memoryBackupPreview(): Promise<MemoryBackupPreview>;
  memoryCloudBackup(): Promise<MemoryBackupOutcome>;
  memoryCloudRecover(options: {
    generation?: number;
    recoveryFile?: string;
  }): Promise<CloudRecoverOutcome>;
  memoryCloudProtect(options: {
    recoveryFile?: string;
  }): Promise<MemoryProtectCommandResult>;
  memoryProtectPasskey(): Promise<
    | { status: 'not-authenticated' }
    | { status: 'insecure-local-key' }
    | { status: 'protected'; migrated: number }
  >;
  memoryRecoverPasskey(): Promise<
    | { status: 'not-authenticated' }
    | { status: 'no-backup' }
    | { status: 'recovered'; objects: number; generation: number }
  >;
  memoryCloudStatus(): Promise<MemoryCloudStatus>;
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
    .description('Back up, protect, and recover private agent memory (Claude)');

  memory
    .command('scan')
    .description('Discover portable agent memory on this machine (read-only)')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show per-item diagnostics')
    .action(async (options: Flags) => {
      const items = await dependencies.memoryScan();
      if (options.json) {
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
      'Back up private memory locally and, when signed in, to Stack Cloud',
    )
    .option(
      '--dry-run',
      'preview the backup composition without changing anything',
    )
    .option('--verbose', 'show per-item detail (with --dry-run)')
    .option('--json', 'emit structured JSON only')
    .action(async (options: Flags) => {
      if (options.dryRun) {
        const preview = await dependencies.memoryBackupPreview();
        if (options.json) {
          emitJson(dependencies, {
            provider: preview.provider,
            nativeFiles: preview.nativeFiles,
            nativeProjects: preview.nativeProjects,
            retainedFiles: preview.retainedFiles,
            retainedProjects: preview.retainedProjects,
            finalFiles: preview.finalFiles,
            finalProjects: preview.finalProjects,
            privacy: preview.privacy,
            dryRun: true,
          });
          return;
        }
        dependencies.writeOut(
          renderMemoryBackupPreview(preview, {
            verbose: options.verbose === true,
          }),
        );
        return;
      }
      if (!options.json)
        dependencies.writeOut('Backing up Claude memory...\n\n');
      const outcome = await dependencies.memoryCloudBackup();
      if (options.json) {
        emitJson(dependencies, outcome);
        return;
      }
      dependencies.writeOut(renderMemoryCloudBackup(outcome));
    });

  memory
    .command('protect')
    .description('Enable client-side encrypted (Protected) Cloud backup')
    .option('--passkey', 'set up a passkey recovery method in the browser')
    .option('--recovery-file <path>', 'where to write the recovery file')
    .option('--json', 'emit structured JSON only')
    .action(
      async (options: {
        passkey?: boolean;
        recoveryFile?: string;
        json?: boolean;
      }) => {
        if (options.passkey) {
          const result = await dependencies.memoryProtectPasskey();
          if (options.json) {
            emitJson(
              dependencies,
              result.status === 'protected'
                ? { ...result, recoveryMethod: 'passkey' }
                : result,
            );
            return;
          }
          if (result.status === 'not-authenticated') {
            dependencies.writeOut('Not signed in.\nRun `stack login` first.\n');
            return;
          }
          if (result.status === 'insecure-local-key') {
            dependencies.writeOut(INSECURE_LOCAL_KEY_MESSAGE);
            return;
          }
          dependencies.writeOut(
            renderMemoryProtect({
              recoveryMethod: 'passkey',
              migrated: result.migrated,
            }),
          );
          return;
        }
        const result = await dependencies.memoryCloudProtect({
          ...(options.recoveryFile
            ? { recoveryFile: options.recoveryFile }
            : {}),
        });
        if (options.json) {
          emitJson(
            dependencies,
            'status' in result
              ? result
              : { ...result, recoveryMethod: 'recovery-file' },
          );
          return;
        }
        if ('status' in result) {
          dependencies.writeOut(
            result.status === 'insecure-local-key'
              ? INSECURE_LOCAL_KEY_MESSAGE
              : 'Not signed in.\nRun `stack login` first.\n',
          );
          return;
        }
        dependencies.writeOut(
          renderMemoryProtect({ ...result, recoveryMethod: 'recovery-file' }),
        );
      },
    );

  memory
    .command('recover')
    .description('Recover the private memory store from Stack Cloud')
    .option(
      '--generation <n>',
      'recover a specific generation (default: latest)',
    )
    .option(
      '--passkey',
      'unlock Protected memory with a passkey in the browser',
    )
    .option(
      '--recovery-file <path>',
      'unlock Protected memory with a recovery file',
    )
    .option('--json', 'emit structured JSON only')
    .action(
      async (options: {
        generation?: string;
        passkey?: boolean;
        recoveryFile?: string;
        json?: boolean;
      }) => {
        if (options.passkey) {
          const result = await dependencies.memoryRecoverPasskey();
          if (options.json) {
            emitJson(dependencies, result);
            return;
          }
          if (result.status === 'not-authenticated') {
            dependencies.writeOut('Not signed in.\nRun `stack login` first.\n');
            return;
          }
          if (result.status === 'no-backup') {
            dependencies.writeOut('No Cloud backup found for this account.\n');
            return;
          }
          dependencies.writeOut(
            renderMemoryRecover({
              status: 'recovered',
              privacyMode: 'protected',
              objects: result.objects,
              generation: result.generation,
            }),
          );
          return;
        }
        const outcome = await dependencies.memoryCloudRecover({
          ...(options.generation !== undefined
            ? { generation: Number.parseInt(options.generation, 10) }
            : {}),
          ...(options.recoveryFile
            ? { recoveryFile: options.recoveryFile }
            : {}),
        });
        if (options.json) {
          emitJson(dependencies, outcome);
          return;
        }
        dependencies.writeOut(renderMemoryRecover(outcome));
      },
    );

  memory
    .command('status')
    .description('Show local and Cloud memory backup status')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detail')
    .action(async (options: Flags) => {
      const [local, cloud] = await Promise.all([
        dependencies.memoryStatus(),
        dependencies.memoryCloudStatus(),
      ]);
      if (options.json) {
        emitJson(dependencies, {
          local: local ?? { provider: 'claude', files: 0, projects: 0 },
          cloud,
        });
        return;
      }
      dependencies.writeOut(renderMemoryCloudStatus(local, cloud));
    });

  memory
    .command('restore')
    .description('Restore native agent memory from Stack’s private store')
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

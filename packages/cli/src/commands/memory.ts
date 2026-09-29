import { Option, type Command } from 'commander';

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
  MemoryGenerationsOutcome,
} from '../memory/cloud-ops.js';
import {
  historicalBaseBackupWarning,
  renderMemoryBackupPreview,
  renderMemoryCloudBackup,
  renderMemoryCloudStatus,
  renderMemoryGenerations,
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
  memoryGenerations(): Promise<MemoryGenerationsOutcome>;
  memoryCloudProtect(options: {
    recoveryFile?: string;
  }): Promise<MemoryProtectCommandResult>;
  memoryProtectPasskey(): Promise<
    | { status: 'not-authenticated' }
    | { status: 'insecure-local-key' }
    | { status: 'protected'; migrated: number }
  >;
  memoryRecoverPasskey(options: {
    generation?: number;
  }): Promise<
    | { status: 'not-authenticated' }
    | { status: 'no-backup' }
    | { status: 'recovered'; objects: number; generation: number }
  >;
  memoryCloudStatus(): Promise<MemoryCloudStatus>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

type Flags = {
  json?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  yes?: boolean;
};

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
    .option(
      '-y, --yes',
      'confirm superseding a newer Cloud generation (non-interactive)',
    )
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
            supersedes: preview.supersession.supersedes,
            // Public CLI JSON uses backup terminology only; internal generation-named
            // values are translated at this presentation boundary.
            localSourceBackup: preview.supersession.localRecoveredGeneration,
            cloudLatestBackup: preview.supersession.cloudLatestGeneration,
            parentBackup: preview.supersession.parentGeneration,
            nextBackup: preview.supersession.nextGeneration,
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
      // Backing up after a historical recovery would supersede a newer Cloud
      // backup — require explicit confirmation (fail closed).
      const preview = await dependencies.memoryBackupPreview();
      if (preview.supersession.supersedes) {
        if (options.json && options.yes !== true) {
          emitJson(dependencies, {
            status: 'supersession-unconfirmed',
            supersedes: true,
            localSourceBackup: preview.supersession.localRecoveredGeneration,
            cloudLatestBackup: preview.supersession.cloudLatestGeneration,
            parentBackup: preview.supersession.parentGeneration,
            nextBackup: preview.supersession.nextGeneration,
          });
          return;
        }
        if (!options.json)
          dependencies.writeOut(
            `${historicalBaseBackupWarning(preview.supersession)}\n\n`,
          );
        const ok =
          options.yes === true ||
          (await dependencies.confirm('Create the new backup and supersede?'));
        if (!ok) {
          if (!options.json) dependencies.writeOut('Cancelled.\n');
          return;
        }
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

  // `stack memory history` (was `generations`). Users see immutable Cloud generations
  // as "backups"; the internal generation model is unchanged.
  const historyAction = async (options: Flags) => {
    const outcome = await dependencies.memoryGenerations();
    const rows = (outcome.status === 'ok' ? outcome.generations : []).map(
      (g) => ({
        // Public CLI JSON uses backup terminology only; the internal generation
        // number is translated to `backup` at this presentation boundary.
        backup: g.generation,
        createdAt: g.createdAt,
        privacyMode: g.privacyMode,
        state: g.state,
        payloadBytes: g.payloadBytes,
        latest: g.latest,
      }),
    );
    if (options.json) {
      emitJson(dependencies, { backups: rows });
      return;
    }
    dependencies.writeOut(
      renderMemoryGenerations(
        outcome.status === 'ok' ? outcome.generations : [],
        { authenticated: outcome.status === 'ok' },
      ),
    );
  };

  memory
    .command('history')
    .description('Show your Memory backup history (newest first)')
    .option('--json', 'emit structured JSON only')
    .action(historyAction);

  // Hidden backward-compatibility alias for the previous public command name.
  memory
    .command('generations', { hidden: true })
    .description('Alias for `stack memory history`')
    .option('--json', 'emit structured JSON only')
    .action(historyAction);

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
    .option('--backup <n>', 'recover a specific backup (default: latest)')
    // Hidden backward-compatibility alias for the previous option name.
    .addOption(new Option('--generation <n>', 'alias for --backup').hideHelp())
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
        backup?: string;
        generation?: string;
        passkey?: boolean;
        recoveryFile?: string;
        json?: boolean;
      }) => {
        // Resolve --backup / --generation (alias). Reject a genuine conflict.
        if (
          options.backup !== undefined &&
          options.generation !== undefined &&
          options.backup !== options.generation
        ) {
          dependencies.writeOut(
            'Specify only one of --backup or --generation.\n',
          );
          return;
        }
        const selector = options.backup ?? options.generation;
        const generation =
          selector !== undefined ? Number.parseInt(selector, 10) : undefined;
        const notFoundMessage =
          generation !== undefined
            ? `Backup #${generation} was not found.\n`
            : 'No Cloud backup found for this account.\n';

        if (options.passkey) {
          const result = await dependencies.memoryRecoverPasskey({
            ...(generation !== undefined ? { generation } : {}),
          });
          if (options.json) {
            emitJson(
              dependencies,
              result.status === 'recovered'
                ? {
                    status: result.status,
                    objects: result.objects,
                    backup: result.generation,
                  }
                : result,
            );
            return;
          }
          if (result.status === 'not-authenticated') {
            dependencies.writeOut('Not signed in.\nRun `stack login` first.\n');
            return;
          }
          if (result.status === 'no-backup') {
            dependencies.writeOut(notFoundMessage);
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
          ...(generation !== undefined ? { generation } : {}),
          ...(options.recoveryFile
            ? { recoveryFile: options.recoveryFile }
            : {}),
        });
        if (options.json) {
          emitJson(
            dependencies,
            outcome.status === 'recovered'
              ? {
                  status: outcome.status,
                  privacyMode: outcome.privacyMode,
                  objects: outcome.objects,
                  backup: outcome.generation,
                }
              : outcome,
          );
          return;
        }
        if (outcome.status === 'no-backup') {
          dependencies.writeOut(notFoundMessage);
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
        // Public CLI JSON uses backup terminology only; internal generation-named
        // fields are translated at this presentation boundary.
        emitJson(dependencies, {
          local: local ?? { provider: 'claude', files: 0, projects: 0 },
          cloud: {
            authenticated: cloud.authenticated,
            privacyMode: cloud.privacyMode,
            lastCloudBackupAt: cloud.lastCloudBackupAt,
            recoveryMethodTypes: cloud.recoveryMethodTypes,
            deviceEnrolled: cloud.deviceEnrolled,
            historicalRecovery: cloud.historicalRecovery,
            localRecoveredBackup: cloud.localRecoveredGeneration,
            cloudLatestBackup: cloud.latestGeneration,
          },
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

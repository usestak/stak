import { Option, type Command } from 'commander';

import type {
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
} from '@stack/memory';
import { toManifestItem } from '@stack/memory';

import { StackCompositionError } from '@stack/core';

import type {
  ConflictDiff,
  ConflictSide,
  KeepSide,
  MaterializeOutcome,
  PendingConflictSummary,
  ResolveConflictOutcome,
} from '../memory/canonical-ops.js';
import { canonicalExtraNotes } from '../ui/cloud.js';
import type {
  CloudRecoverOutcome,
  MemoryBackupOutcome,
  MemoryCloudStatus,
  MemoryGenerationsOutcome,
  PasskeyFailureReason,
} from '../memory/cloud-ops.js';
import { HISTORICAL_NO_SYNC_HISTORY_MESSAGE } from '../memory/cloud-ops.js';
import {
  freshRegistryGuardWarning,
  historicalBaseBackupWarning,
  renderMemoryBackupPreview,
  renderMemoryCloudBackup,
  renderMemoryCloudStatus,
  renderMemoryGenerations,
  renderMemoryProtect,
  renderMemoryRecover,
  renderMemoryRestore,
  renderMemoryScan,
  renderPasskeyFailure,
  type MemoryBackupPreview,
} from '../ui/memory.js';

export type MemoryProtectCommandResult =
  | { migrated: number; recoveryFilePath?: string }
  | { status: 'not-authenticated' }
  | { status: 'insecure-local-key' };

const INSECURE_LOCAL_KEY_MESSAGE =
  'Could not secure local Memory key storage on this device.\n' +
  'Protected Memory was not enabled.\n' +
  'Check the permissions on your STAK home directory and try again.\n';

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
    | { status: 'passkey-failed'; reason: PasskeyFailureReason }
    | { status: 'protected'; migrated: number }
  >;
  memoryRecoverPasskey(options: { generation?: number }): Promise<
    | { status: 'not-authenticated' }
    | { status: 'no-backup' }
    | { status: 'passkey-failed'; reason: PasskeyFailureReason }
    | {
        status: 'recovered';
        objects: number;
        files: number;
        generation: number;
      }
  >;
  memoryCloudStatus(): Promise<MemoryCloudStatus>;
  /** Task 14: `stak memory resolve` / `diff` / `materialize`. Optional so
   * existing test harnesses need no change; missing = "not available". */
  memoryListConflicts?(): Promise<PendingConflictSummary[]>;
  memoryResolveConflict?(options: {
    project: string;
    path: string;
    keep: KeepSide;
  }): Promise<ResolveConflictOutcome>;
  memoryDiffConflict?(options: {
    project: string;
    path: string;
  }): Promise<ConflictDiff>;
  memoryMaterialize?(options: { project?: string }): Promise<MaterializeOutcome>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const KEEP_SIDES: readonly KeepSide[] = ['local', 'cloud', 'both'];

const renderConflictSide = (side: ConflictSide): string =>
  side.state === 'present'
    ? side.text.endsWith('\n')
      ? side.text
      : `${side.text}\n`
    : side.state === 'deleted'
      ? '(deleted)\n'
      : '(absent)\n';

const renderPendingConflicts = (pending: PendingConflictSummary[]): string => {
  if (pending.length === 0) return 'No pending Memory conflicts.\n';
  const lines = [
    `${pending.length} pending Memory conflict(s):`,
    '',
    ...pending.map((c) => `  ${c.projectId}  ${c.name}  ${c.path}  (${c.reason})`),
    '',
    'See both versions: stak memory diff <project> <path>',
    'Resolve:           stak memory resolve <project> <path> --keep local|cloud|both',
    'Then:              stak push',
  ];
  return `${lines.join('\n')}\n`;
};

const renderResolveOutcome = (outcome: ResolveConflictOutcome): string => {
  const kept = outcome.altPath
    ? `kept both: Cloud's version at ${outcome.path}, yours at ${outcome.altPath}`
    : `kept ${outcome.keep}${outcome.state === 'deleted' ? ' (deleted)' : ''}`;
  const lines = [`Resolved ${outcome.path} in ${outcome.name}: ${kept}.`];
  if (outcome.remaining > 0)
    lines.push(
      `${outcome.remaining} Memory conflict(s) left. Run \`stak memory resolve\` to list them.`,
    );
  else {
    lines.push('All Memory conflicts resolved. Run `stak push` to publish.');
    const notes = outcome.materialize
      ? canonicalExtraNotes({
          unavailable: outcome.materialize.unavailable,
          conflicts: outcome.materialize.conflicts,
        })
      : [];
    if (notes.length > 0) lines.push(`Agent files: ${notes.join('; ')}.`);
  }
  return `${lines.join('\n')}\n`;
};

const renderMaterializeOutcome = (outcome: MaterializeOutcome): string => {
  const lines = [
    `Materialized Memory for ${outcome.materialized} project(s): ${outcome.written} file(s) written, ${outcome.deleted} removed.`,
  ];
  const notes = canonicalExtraNotes({
    unavailable: outcome.unavailable,
    conflicts: outcome.conflicts,
  });
  if (notes.length > 0) lines.push(`${notes.join('; ')}.`);
  return `${lines.join('\n')}\n`;
};

const required = <T>(dependency: T | undefined): T => {
  if (dependency === undefined)
    throw new StackCompositionError(
      'memory-command-unavailable',
      'This Memory command is not available.',
    );
  return dependency;
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
      'Back up private memory locally and, when signed in, to STAK Cloud',
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
            availableProjects: preview.availableProjects,
            nativeFiles: preview.nativeFiles,
            nativeProjects: preview.nativeProjects,
            retainedFiles: preview.retainedFiles,
            retainedProjects: preview.retainedProjects,
            retainedAvailableFiles: preview.retainedAvailableFiles,
            retainedUnavailableFiles: preview.retainedUnavailableFiles,
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
            risksDuplicatingLocalProjects:
              preview.risksDuplicatingLocalProjects === true,
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
      // Fresh/reset-registry safeguard: this machine has never recovered Cloud Memory,
      // Cloud already has history, and this backup would mint a brand-new Local-only
      // Project — refuse outright (no `-y` override; silently minting a duplicate
      // logical Project is never something to confirm past).
      const preview = await dependencies.memoryBackupPreview();
      if (preview.risksDuplicatingLocalProjects) {
        if (options.json) {
          emitJson(dependencies, { status: 'needs-recovery-first' });
          return;
        }
        dependencies.writeOut(`${freshRegistryGuardWarning()}\n`);
        return;
      }
      // Final review T15-4: the same refusal as `stak push` — no sync history
      // means the rollback can't be told apart from Cloud, so there is nothing
      // safe to confirm.
      if (preview.supersession.supersedes && preview.supersession.noSyncHistory) {
        if (options.json) {
          emitJson(dependencies, { status: 'needs-catch-up' });
          return;
        }
        dependencies.writeOut(`${HISTORICAL_NO_SYNC_HISTORY_MESSAGE}\n`);
        return;
      }
      // Backing up after a historical recovery would supersede a newer Cloud
      // backup — require explicit confirmation (fail closed).
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

  // `stak memory history` (was `generations`). Users see immutable Cloud generations
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
    .description('Alias for `stak memory history`')
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
            dependencies.writeOut('Not signed in.\nRun `stak login` first.\n');
            return;
          }
          if (result.status === 'insecure-local-key') {
            dependencies.writeOut(INSECURE_LOCAL_KEY_MESSAGE);
            return;
          }
          if (result.status === 'passkey-failed') {
            dependencies.writeOut(
              renderPasskeyFailure('protect', result.reason),
            );
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
              : 'Not signed in.\nRun `stak login` first.\n',
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
    .description('Recover the private memory store from STAK Cloud')
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
                    files: result.files,
                    backup: result.generation,
                  }
                : result,
            );
            return;
          }
          if (result.status === 'not-authenticated') {
            dependencies.writeOut('Not signed in.\nRun `stak login` first.\n');
            return;
          }
          if (result.status === 'no-backup') {
            dependencies.writeOut(notFoundMessage);
            return;
          }
          if (result.status === 'passkey-failed') {
            dependencies.writeOut(
              renderPasskeyFailure('recover', result.reason),
            );
            return;
          }
          dependencies.writeOut(
            renderMemoryRecover({
              status: 'recovered',
              privacyMode: 'protected',
              objects: result.objects,
              files: result.files,
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
                  files: outcome.files,
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

  // Task 14 — spec §8.3: diff (opt-in, the only command that shows content),
  // resolve, then push.
  memory
    .command('diff <project> <path>')
    .description(
      'Show both versions of a pending Memory conflict (prints Memory content)',
    )
    .action(async (project: string, docPath: string) => {
      const diff = await required(dependencies.memoryDiffConflict)({
        project,
        path: docPath,
      });
      dependencies.writeOut(
        `${diff.name}  ${diff.path}  (${diff.reason}, against Cloud generation ${diff.generation})\n` +
          `--- local ---\n${renderConflictSide(diff.local)}` +
          `--- cloud ---\n${renderConflictSide(diff.cloud)}`,
      );
    });

  memory
    .command('resolve [project] [path]')
    .description(
      'Resolve a Memory conflict: keep local, keep cloud, or keep both (no arguments: list conflicts)',
    )
    .option('--keep <side>', 'local | cloud | both')
    .action(
      async (
        project: string | undefined,
        docPath: string | undefined,
        options: { keep?: string },
      ) => {
        if (project === undefined) {
          dependencies.writeOut(
            renderPendingConflicts(
              await required(dependencies.memoryListConflicts)(),
            ),
          );
          return;
        }
        if (docPath === undefined)
          throw new StackCompositionError(
            'memory-resolve-usage',
            'Usage: stak memory resolve <project> <path> --keep local|cloud|both',
          );
        const keep = options.keep as KeepSide | undefined;
        if (keep === undefined || !KEEP_SIDES.includes(keep))
          throw new StackCompositionError(
            'memory-resolve-usage',
            'Choose a side: --keep local, --keep cloud, or --keep both.',
          );
        const outcome = await required(dependencies.memoryResolveConflict)({
          project,
          path: docPath,
          keep,
        });
        dependencies.writeOut(renderResolveOutcome(outcome));
      },
    );

  memory
    .command('materialize [project]')
    .description(
      'Rebuild agent Memory files from STAK Memory (all projects on this machine, or one)',
    )
    .option('--agent <agent>', 'agent to write (claude)', 'claude')
    .action(
      async (project: string | undefined, options: { agent: string }) => {
        if (options.agent !== 'claude')
          throw new StackCompositionError(
            'memory-materialize-agent',
            `Unsupported agent "${options.agent}". Only claude is supported in this version.`,
          );
        const outcome = await required(dependencies.memoryMaterialize)(
          project !== undefined ? { project } : {},
        );
        dependencies.writeOut(renderMaterializeOutcome(outcome));
      },
    );

  memory
    .command('restore')
    .description('Restore native agent memory from STAK’s private store')
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

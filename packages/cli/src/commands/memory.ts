import { Option, type Command } from 'commander';

import type {
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
  UnlockResult,
} from '@stack/memory';
import { formatLockAge, toManifestItem } from '@stack/memory';

import type { ProjectFoldNote } from '../memory/project-fold.js';

import { StackCompositionError } from '@stack/core';

import type {
  ConflictDiff,
  ConflictSide,
  KeepSide,
  MaterializeOutcome,
  PendingConflictSummary,
  ResolveConflictOutcome,
} from '../memory/canonical-ops.js';
import { canonicalExtraNotes, projectFoldNotes } from '../ui/cloud.js';
import {
  AGENT_EXPORT_IDS,
  isAgentExportId,
  safelyExportAgentMemory,
  type AgentDisableReport,
  type AgentExportId,
  type AgentExportReport,
  type AgentMemoryStatusReport,
  type AgentResetReport,
} from '../memory/agent-export-ops.js';
import {
  agentMemoryStatusLines,
  renderAgentDisable,
  renderAgentExportNotes,
  renderAgentMemoryList,
  renderAgentReset,
} from '../ui/agent-memory.js';
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
        legacyFiles: number;
        projectFiles: number;
        generation: number;
        /** Spec §4.2.1: former Project IDs folded after the recover. */
        folded?: ProjectFoldNote[];
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
  memoryMaterialize?(options: {
    project?: string;
  }): Promise<MaterializeOutcome>;
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
  /** `stak memory unlock` (spec 2026-10-25 §3.6). Never takes the lock itself. */
  unlockMemory?(options: { force: boolean }): Promise<UnlockResult>;
  /** Spec 2026-10-28 §7: refresh every enabled agent's Memory file. Called at
   * the end of a Memory command's locked span; never fails the command. */
  exportAgentMemory?(): Promise<AgentExportReport>;
  /** `stak memory agents enable|disable|reset <agent>` (run inside the lock). */
  enableAgentMemory?(agent: AgentExportId): Promise<AgentExportReport>;
  disableAgentMemory?(agent: AgentExportId): Promise<AgentDisableReport>;
  resetAgentMemory?(agent: AgentExportId): Promise<AgentResetReport>;
  /** Read-only: each agent's on/off state and file status. */
  agentMemoryStatus?(): Promise<AgentMemoryStatusReport>;
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
    ...pending.map(
      (c) => `  ${c.projectId}  ${c.name}  ${c.path}  (${c.reason})`,
    ),
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
  const lines = [
    // Spec §4.2.1: a project merged before resolving is reported once.
    ...projectFoldNotes(outcome.folded).map((note) => `${note}.`),
    `Resolved ${outcome.path} in ${outcome.name}: ${kept}.`,
  ];
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
    folded: outcome.folded,
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

  // Memory-changing subcommands hold the Memory lock from their first Memory read to
  // their last Memory write (spec 2026-10-25 §3.2). Read-only ones never take it.
  const locked = <T>(command: string, fn: () => Promise<T>): Promise<T> =>
    dependencies.withMemoryLock
      ? dependencies.withMemoryLock(command, fn)
      : fn();
  // Spec 2026-10-28 §7: the agent files are refreshed at the END of a Memory
  // command's locked span (call this inside `locked`). Never throws.
  const exportAgents = () =>
    safelyExportAgentMemory(dependencies.exportAgentMemory?.bind(dependencies));
  const writeNotes = (report: AgentExportReport | undefined) => {
    const notes = renderAgentExportNotes(report);
    if (notes) dependencies.writeOut(notes);
  };
  const agentStatus = async (): Promise<
    AgentMemoryStatusReport | undefined
  > => {
    if (!dependencies.agentMemoryStatus) return undefined;
    try {
      return await dependencies.agentMemoryStatus();
    } catch {
      return undefined;
    }
  };

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
      // The preview read, the confirmation and the backup write all happen under the
      // lock, so the confirmed preview cannot go stale (spec 2026-10-25 §3.2).
      await locked('stak memory backup', async () => {
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
        if (
          preview.supersession.supersedes &&
          preview.supersession.noSyncHistory
        ) {
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
            (await dependencies.confirm(
              'Create the new backup and supersede?',
            ));
          if (!ok) {
            if (!options.json) dependencies.writeOut('Cancelled.\n');
            return;
          }
        }
        if (!options.json)
          dependencies.writeOut('Backing up Claude memory...\n\n');
        const outcome = await dependencies.memoryCloudBackup();
        const agentMemory = await exportAgents();
        if (options.json) {
          emitJson(dependencies, {
            ...outcome,
            ...(agentMemory ? { agentMemory } : {}),
          });
          return;
        }
        dependencies.writeOut(renderMemoryCloudBackup(outcome));
        writeNotes(agentMemory);
      });
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
      }) =>
        locked('stak memory protect', async () => {
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
              dependencies.writeOut(
                'Not signed in.\nRun `stak login` first.\n',
              );
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
        }),
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

        await locked('stak memory recover', async () => {
          if (options.passkey) {
            const result = await dependencies.memoryRecoverPasskey({
              ...(generation !== undefined ? { generation } : {}),
            });
            const agentMemory =
              result.status === 'recovered' ? await exportAgents() : undefined;
            if (options.json) {
              emitJson(
                dependencies,
                result.status === 'recovered'
                  ? {
                      status: result.status,
                      objects: result.objects,
                      files: result.files,
                      legacyFiles: result.legacyFiles,
                      projectFiles: result.projectFiles,
                      backup: result.generation,
                      ...(agentMemory ? { agentMemory } : {}),
                    }
                  : result,
              );
              return;
            }
            if (result.status === 'not-authenticated') {
              dependencies.writeOut(
                'Not signed in.\nRun `stak login` first.\n',
              );
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
                legacyFiles: result.legacyFiles,
                projectFiles: result.projectFiles,
                generation: result.generation,
                ...(result.folded ? { folded: result.folded } : {}),
              }),
            );
            writeNotes(agentMemory);
            return;
          }
          const outcome = await dependencies.memoryCloudRecover({
            ...(generation !== undefined ? { generation } : {}),
            ...(options.recoveryFile
              ? { recoveryFile: options.recoveryFile }
              : {}),
          });
          const agentMemory =
            outcome.status === 'recovered' ? await exportAgents() : undefined;
          if (options.json) {
            emitJson(
              dependencies,
              outcome.status === 'recovered'
                ? {
                    status: outcome.status,
                    privacyMode: outcome.privacyMode,
                    objects: outcome.objects,
                    files: outcome.files,
                    legacyFiles: outcome.legacyFiles,
                    projectFiles: outcome.projectFiles,
                    backup: outcome.generation,
                    ...(agentMemory ? { agentMemory } : {}),
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
          writeNotes(agentMemory);
        });
      },
    );

  memory
    .command('status')
    .description('Show local and Cloud memory backup status')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show detail')
    .action(async (options: Flags) => {
      const [local, cloud, agents] = await Promise.all([
        dependencies.memoryStatus(),
        dependencies.memoryCloudStatus(),
        agentStatus(),
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
          ...(agents ? { agentMemory: agents } : {}),
        });
        return;
      }
      const agentLines = agentMemoryStatusLines(agents);
      dependencies.writeOut(
        renderMemoryCloudStatus(local, cloud) +
          (agentLines.length > 0 ? `${agentLines.join('\n')}\n` : ''),
      );
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
        const resolveConflict = required(dependencies.memoryResolveConflict);
        const { outcome, agentMemory } = await locked(
          'stak memory resolve',
          async () => {
            const resolved = await resolveConflict({
              project,
              path: docPath,
              keep,
            });
            // Only the final resolve changes Memory (and materializes it).
            return {
              outcome: resolved,
              agentMemory:
                resolved.remaining === 0 ? await exportAgents() : undefined,
            };
          },
        );
        dependencies.writeOut(renderResolveOutcome(outcome));
        writeNotes(agentMemory);
      },
    );

  memory
    .command('materialize [project]')
    .description(
      'Rebuild agent Memory files from STAK Memory (all projects on this machine, or one)',
    )
    .option('--agent <agent>', 'agent to write (claude)', 'claude')
    .action(async (project: string | undefined, options: { agent: string }) => {
      if (options.agent !== 'claude')
        throw new StackCompositionError(
          'memory-materialize-agent',
          `Unsupported agent "${options.agent}". Only claude is supported in this version.`,
        );
      const materialize = required(dependencies.memoryMaterialize);
      const { outcome, agentMemory } = await locked(
        'stak memory materialize',
        async () => {
          const materialized = await materialize(
            project !== undefined ? { project } : {},
          );
          return { outcome: materialized, agentMemory: await exportAgents() };
        },
      );
      dependencies.writeOut(renderMaterializeOutcome(outcome));
      writeNotes(agentMemory);
    });

  // Spec 2026-10-28 §7: share project Memory with Codex and Cursor.
  const agentOf = (value: string): AgentExportId => {
    if (!isAgentExportId(value))
      throw new StackCompositionError(
        'memory-agents-unknown-agent',
        `Unknown agent "${value}". Choose ${AGENT_EXPORT_IDS.join(' or ')}.`,
      );
    return value;
  };
  const agents = memory
    .command('agents')
    .description(
      'Share project Memory with Codex and Cursor (list, enable, disable, reset)',
    )
    .option('--json', 'emit structured JSON only')
    .action(async (options: Flags) => {
      const report = await required(dependencies.agentMemoryStatus)();
      if (options.json) {
        emitJson(dependencies, report);
        return;
      }
      dependencies.writeOut(renderAgentMemoryList(report));
    });
  agents
    .command('enable <agent>')
    .description('Share project Memory with an agent and write its files now')
    .action(async (value: string) => {
      const agent = agentOf(value);
      const enable = required(dependencies.enableAgentMemory);
      const report = await locked('stak memory agents enable', () =>
        safelyExportAgentMemory(() => enable(agent)),
      );
      dependencies.writeOut(renderAgentExportNotes(report, 'enable'));
    });
  agents
    .command('disable <agent>')
    .description(
      "Stop sharing project Memory with an agent and remove STAK's files",
    )
    .action(async (value: string) => {
      const agent = agentOf(value);
      const disable = required(dependencies.disableAgentMemory);
      const report = await locked(
        'stak memory agents disable',
        async (): Promise<AgentDisableReport> => {
          try {
            return await disable(agent);
          } catch (error) {
            return {
              agent,
              removed: 0,
              kept: [],
              failed: [],
              problems: [
                {
                  code: 'failed',
                  message: `Agent memory cleanup stopped: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      );
      dependencies.writeOut(renderAgentDisable(report));
    });
  agents
    .command('reset <agent>')
    .description(
      "Rewrite an agent's STAK Memory files, including hand-edited ones",
    )
    .action(async (value: string) => {
      const agent = agentOf(value);
      const reset = required(dependencies.resetAgentMemory);
      const report = await locked(
        'stak memory agents reset',
        async (): Promise<AgentResetReport> => {
          try {
            return await reset(agent);
          } catch (error) {
            return {
              enabled: true,
              agents: [],
              problems: [
                {
                  code: 'failed',
                  message: `Agent memory reset stopped: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      );
      dependencies.writeOut(renderAgentReset(agent, report));
    });

  memory
    .command('restore')
    .description('Restore native agent memory from STAK’s private store')
    .option('--dry-run', 'preview without changing agent memory')
    .option('--json', 'emit structured JSON only')
    .option('--verbose', 'show per-item detail')
    .action(async (options: Flags) => {
      const dryRun = options.dryRun === true;
      // Only an applying restore writes Memory; a --dry-run preview never takes the lock.
      const plan = dryRun
        ? await dependencies.memoryRestore({ apply: false })
        : await locked('stak memory restore', () =>
            dependencies.memoryRestore({ apply: true }),
          );
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

  // Spec 2026-10-25 §3.6: the manual fallback for a leftover lock that looks held (for
  // example a crashed command's PID reused by another program). It must never take the
  // Memory lock itself — that is the lock it is removing.
  memory
    .command('unlock')
    .description(
      'Remove a leftover Memory lock left behind by a crashed STAK command',
    )
    .option(
      '--force',
      'remove the lock even if its process may still be running (can lose Memory changes)',
    )
    .action(async (options: { force?: boolean }) => {
      if (!dependencies.unlockMemory)
        throw new Error('Memory unlock is not available.');
      const result = await dependencies.unlockMemory({
        force: options.force === true,
      });
      if (result.status === 'no-lock') {
        dependencies.writeOut('No Memory lock is held.\n');
        return;
      }
      if (result.status === 'refused') {
        const { holder } = result;
        // Re-running with --force would not help here: the lock was replaced on every look.
        if (result.reason === 'changing')
          throw new StackCompositionError(
            'memory-unlock-refused',
            `The Memory lock kept changing while STAK tried to remove it (now held by \`${holder.command}\`, process ${holder.pid} on ${holder.hostname}). ` +
              'Other STAK commands are using Memory. Nothing was removed. Try again when they finish.',
          );
        throw new StackCompositionError(
          'memory-unlock-refused',
          `The Memory lock is held by \`${holder.command}\` (process ${holder.pid} on ${holder.hostname}, started ${formatLockAge(holder.startedAt)} ago), which may still be running.\n` +
            'Wait for it to finish. If you are sure it is not a STAK command, run `stak memory unlock --force`.',
        );
      }
      const { holder, wasAlive } = result;
      if (holder === 'corrupt') {
        dependencies.writeOut('Removed an unreadable Memory lock file.\n');
        return;
      }
      if (wasAlive) {
        dependencies.writeOut(
          'Warning: removing a Memory lock that may belong to a running STAK command. If one is running, its Memory changes can be lost.\n' +
            `Removed the Memory lock held by \`${holder.command}\` (process ${holder.pid}).\n`,
        );
        return;
      }
      dependencies.writeOut(
        `Removed the Memory lock held by \`${holder.command}\` (process ${holder.pid}, started ${formatLockAge(holder.startedAt)} ago, no longer running).\n`,
      );
    });
};

import type { Command } from 'commander';
import type { StackRemoteUseProposal, StackUseProposal } from '@stack/core';
import { renderStackUse } from '../ui/stack.js';
import { remoteUseJson, renderRemoteStackUse } from '../ui/cloud.js';

export type AnyUseProposal = StackUseProposal | StackRemoteUseProposal;

const isRemote = (
  proposal: AnyUseProposal,
): proposal is StackRemoteUseProposal => 'source' in proposal;

export type UseCommandDependencies = {
  prepareUse(input: string): Promise<AnyUseProposal>;
  applyUse(proposal: AnyUseProposal): Promise<unknown>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export const registerUseCommand = (
  program: Command,
  dependencies: UseCommandDependencies,
) => {
  program
    .command('use <stack>')
    .description('Add a local or public (@owner/name) Stack to main')
    .option('--dry-run', 'preview without persistent mutation')
    .option('--json', 'emit structured JSON (with --dry-run)')
    .option('--yes', 'approve the desired-state change')
    .action(
      async (
        input: string,
        options: { dryRun?: boolean; json?: boolean; yes?: boolean },
      ) => {
        const proposal = await dependencies.prepareUse(input);
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(
              isRemote(proposal)
                ? remoteUseJson(proposal)
                : {
                    dryRun: true,
                    stack: proposal.loaded.version,
                    layer: proposal.layer,
                    resolution: proposal.resolved,
                    summary: proposal.summary,
                  },
              null,
              2,
            )}\n`,
          );
          return;
        }
        dependencies.writeOut(
          isRemote(proposal)
            ? renderRemoteStackUse(proposal, options.dryRun)
            : renderStackUse(proposal, options.dryRun),
        );
        if (proposal.resolved.conflicts.length)
          throw new Error('Stack has required Skill conflicts.');
        if (options.dryRun) return;
        if (!options.yes && !(await dependencies.confirm('Apply to main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        await dependencies.applyUse(proposal);
        dependencies.writeOut(
          `\n${proposal.layer.name} added to main.\nNo agent bindings were changed.\n`,
        );
      },
    );
};

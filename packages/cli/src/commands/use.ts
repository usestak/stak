import type { Command } from 'commander';
import type {
  StackOwnedUseProposal,
  StackRemoteUseProposal,
  StackUseProposal,
} from '@stack/core';
import { renderStackUse } from '../ui/stack.js';
import {
  ownedUseJson,
  remoteUseJson,
  renderOwnedStackUse,
  renderRemoteStackUse,
} from '../ui/cloud.js';

export type AnyUseProposal =
  StackUseProposal | StackRemoteUseProposal | StackOwnedUseProposal;

// Neither ResolvedOwnedStackSource nor ResolvedPublicStackSource carries a `kind` field, so
// the discriminator uses a field unique to each: `owner` only exists on the public-ref
// source, `stackId` only exists on the owned source (StackUseProposal has neither — it
// carries `loaded`, not `source`, so it never matches either check below).
const isRemote = (
  proposal: AnyUseProposal,
): proposal is StackRemoteUseProposal =>
  'source' in proposal && 'owner' in proposal.source;

const isOwned = (proposal: AnyUseProposal): proposal is StackOwnedUseProposal =>
  'source' in proposal && 'stackId' in proposal.source;

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
    .command('use <stak>')
    .description(
      'Add a local, your own Cloud named, or public (@owner/name) STAK to main',
    )
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
                : isOwned(proposal)
                  ? ownedUseJson(proposal)
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
            : isOwned(proposal)
              ? renderOwnedStackUse(proposal, options.dryRun)
              : renderStackUse(proposal, options.dryRun),
        );
        if (proposal.resolved.conflicts.length)
          throw new Error('STAK has required Skill conflicts.');
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

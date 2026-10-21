import type { Command } from 'commander';
import { StackCompositionError } from '@stack/core';
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

/**
 * `--dry-run` preview for the fresh-machine bootstrap (main missing, zero Skills
 * discovered): an empty main WOULD be created and `stak` added to it. No environment
 * exists yet to compute a real diff against, so this is an honest, minimal preview —
 * never a persistent mutation — rather than a full composed proposal.
 */
export type UseBootstrapPreview = { kind: 'bootstrap-preview'; stak: string };

export type AnyUseProposal =
  | StackUseProposal
  | StackRemoteUseProposal
  | StackOwnedUseProposal
  | UseBootstrapPreview;

const isBootstrapPreview = (
  proposal: AnyUseProposal,
): proposal is UseBootstrapPreview =>
  'kind' in proposal && proposal.kind === 'bootstrap-preview';

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
  prepareUse(
    input: string,
    options: { dryRun: boolean },
  ): Promise<AnyUseProposal>;
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
    .option('--verbose', 'show detailed cloud internals')
    .action(
      async (
        input: string,
        options: { dryRun?: boolean; json?: boolean; yes?: boolean },
      ) => {
        const proposal = await dependencies.prepareUse(input, {
          dryRun: options.dryRun === true,
        });
        if (isBootstrapPreview(proposal)) {
          // Fresh machine, zero Skills: `main` does not exist yet and only a
          // `--dry-run` preview was requested, so nothing was created or written.
          if (options.json) {
            dependencies.writeOut(
              `${JSON.stringify(
                { dryRun: true, bootstrap: 'empty-main', stak: proposal.stak },
                null,
                2,
              )}\n`,
            );
            return;
          }
          dependencies.writeOut(
            `main does not exist yet and no existing Skills were found, so ` +
              `running this without --dry-run will create an empty main and add ` +
              `${proposal.stak} to it.\nNo changes were made.\n`,
          );
          return;
        }
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
        if (proposal.resolved.conflicts.length) {
          // `StackCompositionError`, not a plain `Error` — bin.ts's top-level catch only
          // formats recognized error classes cleanly; a plain `Error` here bypassed that and
          // crashed with a raw Node stack trace instead of a readable CLI message.
          const lines = proposal.resolved.conflicts.map((conflict) => {
            const sources = [
              ...new Set(
                conflict.candidates.flatMap((candidate) =>
                  candidate.origins.map((origin) =>
                    origin.type === 'direct' ? 'main' : origin.stackName,
                  ),
                ),
              ),
            ];
            return `  - ${conflict.name} (required differently by ${sources.join(' and ')})`;
          });
          throw new StackCompositionError(
            'stack-resolution-conflict',
            `STAK has required Skill conflicts:\n${lines.join('\n')}\n\n` +
              'Resolve the conflict (e.g. remove or update one of the conflicting ' +
              'sources) before using this STAK.',
          );
        }
        if (options.dryRun) return;
        if (!options.yes && !(await dependencies.confirm('Apply to main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        await dependencies.applyUse(proposal);
        dependencies.writeOut(
          `\n${proposal.layer.name} added to main.\n` +
            'No agent bindings were changed.\n' +
            'Run `stak push` to sync this change to STAK Cloud.\n',
        );
      },
    );
};

import type { Command } from 'commander';
import type { StackRemoveProposal } from '@stack/core';
import { renderStackRemove } from '../ui/stack.js';

export type RemoveCommandDependencies = {
  prepareRemove(identifier: string): Promise<StackRemoveProposal>;
  applyRemove(proposal: StackRemoveProposal): Promise<unknown>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};
export const registerRemoveCommand = (
  program: Command,
  dependencies: RemoveCommandDependencies,
) => {
  program
    .command('remove <stak>')
    .description('Remove a STAK layer from main (desired state only)')
    .option('--yes', 'approve the desired-state change')
    .action(async (identifier: string, options: { yes?: boolean }) => {
      const proposal = await dependencies.prepareRemove(identifier);
      dependencies.writeOut(renderStackRemove(proposal));
      if (
        !options.yes &&
        !(await dependencies.confirm(
          `Remove ${proposal.layer.name} from main?`,
        ))
      ) {
        dependencies.writeOut('Cancelled. No changes were made.\n');
        return;
      }
      await dependencies.applyRemove(proposal);
      dependencies.writeOut(
        `\n${proposal.layer.name} removed from main.\nNo agent bindings were changed.\n`,
      );
    });
};

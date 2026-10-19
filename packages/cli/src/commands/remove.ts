import type { Command } from 'commander';
import type { SkillRemoveProposal, StackRemoveProposal } from '@stack/core';
import { removedName, renderRemove } from '../ui/stack.js';

export type RemoveProposal = StackRemoveProposal | SkillRemoveProposal;

export type RemoveCommandDependencies = {
  /**
   * A single `remove <identifier>` must resolve BOTH kinds of thing main can hold: a whole
   * STAK layer (an imported Stack) or one direct Skill entry (e.g. one `stak add`ed, now
   * tracked-but-missing). STAK layers are tried first, preserving existing behavior exactly;
   * a direct Skill is only matched when no STAK layer does.
   */
  prepareRemove(identifier: string): Promise<RemoveProposal>;
  applyRemove(proposal: RemoveProposal): Promise<unknown>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};
export const registerRemoveCommand = (
  program: Command,
  dependencies: RemoveCommandDependencies,
) => {
  program
    .command('remove <skill-or-stak>')
    .description(
      'Deliberately remove a Skill or STAK layer from main (desired state only)',
    )
    .option('--yes', 'approve the desired-state change')
    .option('--verbose', 'show detailed cloud internals')
    .action(async (identifier: string, options: { yes?: boolean }) => {
      const proposal = await dependencies.prepareRemove(identifier);
      dependencies.writeOut(renderRemove(proposal));
      const name = removedName(proposal);
      if (
        !options.yes &&
        !(await dependencies.confirm(`Remove ${name} from main?`))
      ) {
        dependencies.writeOut('Cancelled. No changes were made.\n');
        return;
      }
      await dependencies.applyRemove(proposal);
      dependencies.writeOut(
        `\n${name} removed from main.\nNo agent bindings were changed.\n`,
      );
    });
};

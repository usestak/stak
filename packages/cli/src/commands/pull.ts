import type { Command } from 'commander';

import { LocalEnvironmentConflictError } from '@stack/cloud-client';
import type { ApplyPullResult, PullPlan } from '@stack/core';

import { pullPlanJson, renderPullPlan, renderPullResult } from '../ui/cloud.js';

export type PullCommandDependencies = {
  cloudPreparePull(): Promise<PullPlan>;
  cloudApplyPull(plan: PullPlan): Promise<ApplyPullResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export const registerPullCommand = (
  program: Command,
  dependencies: PullCommandDependencies,
): void => {
  program
    .command('pull')
    .description('Download your main Stack from the Cloud')
    .option(
      '--dry-run',
      'preview the pull without downloading or mutating main',
    )
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'restore local main non-interactively')
    .option('--verbose', 'show detailed cloud internals')
    .action(
      async (options: {
        dryRun?: boolean;
        json?: boolean;
        yes?: boolean;
        verbose?: boolean;
      }) => {
        const verbose = options.verbose === true;
        const plan = await dependencies.cloudPreparePull();
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(pullPlanJson(plan), null, 2)}\n`,
          );
          return;
        }
        // A local conflict blocks pull, and --yes never bypasses it.
        if (plan.conflict)
          throw new LocalEnvironmentConflictError(plan.conflict.message);
        if (options.dryRun) {
          dependencies.writeOut(renderPullPlan(plan, { verbose }));
          return;
        }
        if (plan.mode === 'noop') {
          dependencies.writeOut(renderPullPlan(plan, { verbose }));
          return;
        }
        if (!options.yes && !(await dependencies.confirm('Pull main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        dependencies.writeOut('Pulling main...\n\n');
        dependencies.writeOut(
          renderPullResult(await dependencies.cloudApplyPull(plan), {
            verbose,
          }),
        );
      },
    );
};

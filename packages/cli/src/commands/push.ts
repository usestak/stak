import type { Command } from 'commander';

import {
  LocalEnvironmentConflictError,
  RemoteEnvironmentConflictError,
} from '@stack/cloud-client';
import type { ApplyPushResult, PushPlan } from '@stack/core';

import { pushPlanJson, renderPushPlan, renderPushResult } from '../ui/cloud.js';

export type PushCommandDependencies = {
  cloudPreparePush(): Promise<PushPlan>;
  cloudApplyPush(plan: PushPlan): Promise<ApplyPushResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export const registerPushCommand = (
  program: Command,
  dependencies: PushCommandDependencies,
): void => {
  program
    .command('push')
    .description('Push the local main Environment to Stack Cloud')
    .option('--dry-run', 'preview the push without uploading or committing')
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'create the cloud version non-interactively')
    .action(
      async (options: { dryRun?: boolean; json?: boolean; yes?: boolean }) => {
        const plan = await dependencies.cloudPreparePush();
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(pushPlanJson(plan), null, 2)}\n`,
          );
          return;
        }
        // A synchronization conflict blocks push, and --yes never bypasses it.
        if (plan.conflict)
          throw plan.conflict.kind === 'remote-newer'
            ? new RemoteEnvironmentConflictError(plan.conflict.message)
            : new LocalEnvironmentConflictError(plan.conflict.message);
        dependencies.writeOut(renderPushPlan(plan, options.dryRun === true));
        if (options.dryRun) return;
        if (plan.noop) return;
        if (!options.yes && !(await dependencies.confirm('Push main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        dependencies.writeOut(
          renderPushResult(await dependencies.cloudApplyPush(plan)),
        );
      },
    );
};

import type { Command } from 'commander';

import type { PublishPlan } from '@stack/core';
import type { PublishPublicStackVersionResponse } from '@stack/spec';

import {
  publishPlanJson,
  renderPublishPreview,
  renderPublishResult,
} from '../ui/cloud.js';

export type PublishCommandDependencies = {
  cloudPreparePublish(options: {
    input: string;
    slug?: string;
  }): Promise<PublishPlan>;
  cloudApplyPublish(
    plan: PublishPlan,
  ): Promise<PublishPublicStackVersionResponse>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export const registerPublishCommand = (
  program: Command,
  dependencies: PublishCommandDependencies,
): void => {
  program
    .command('publish <stack>')
    .description('Publish a reusable public Stack from a local source or layer')
    .option('--slug <slug>', 'public slug when the Stack name is not slug-safe')
    .option('--dry-run', 'preview the publication without creating a version')
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'publish non-interactively')
    .action(
      async (
        input: string,
        options: {
          slug?: string;
          dryRun?: boolean;
          json?: boolean;
          yes?: boolean;
        },
      ) => {
        const plan = await dependencies.cloudPreparePublish({
          input,
          ...(options.slug ? { slug: options.slug } : {}),
        });
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(publishPlanJson(plan), null, 2)}\n`,
          );
          return;
        }
        dependencies.writeOut(renderPublishPreview(plan));
        if (options.dryRun) return;
        if (plan.noop) return;
        if (
          !options.yes &&
          !(await dependencies.confirm(`Publish ${plan.slug}?`))
        ) {
          dependencies.writeOut('Cancelled. Nothing was published.\n');
          return;
        }
        dependencies.writeOut(
          renderPublishResult(await dependencies.cloudApplyPublish(plan), plan),
        );
      },
    );
};

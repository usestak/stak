import type { Command } from 'commander';

import type { WhoamiResult } from '../cloud/operations.js';

export type WhoamiCommandDependencies = {
  cloudWhoami(): Promise<WhoamiResult>;
  writeOut(value: string): void;
};

export const registerWhoamiCommand = (
  program: Command,
  dependencies: WhoamiCommandDependencies,
): void => {
  program
    .command('whoami')
    .description('Show the signed-in Stack Cloud account')
    .option('--json', 'emit structured JSON only')
    .action(async (options: { json?: boolean }) => {
      const me = await dependencies.cloudWhoami();
      if (options.json) {
        dependencies.writeOut(
          `${JSON.stringify(
            {
              userId: me.userId,
              githubUsername: me.githubUsername ?? null,
              displayName: me.displayName ?? null,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const name = me.displayName ?? me.githubUsername ?? me.userId;
      const github = me.githubUsername ? `\n@${me.githubUsername}` : '';
      dependencies.writeOut(`${name}${github}\n`);
    });
};

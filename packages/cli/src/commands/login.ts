import type { Command } from 'commander';

import type { LoginResult } from '../cloud/operations.js';

export type LoginCommandDependencies = {
  cloudLogin(options: {
    apiUrl?: string;
    label?: string;
    openBrowser?: boolean;
  }): Promise<LoginResult>;
};

export const registerLoginCommand = (
  program: Command,
  dependencies: LoginCommandDependencies,
): void => {
  program
    .command('login')
    .description('Sign in to Stack Cloud through your browser')
    .option('--api-url <url>', 'Stack Cloud API base URL')
    .option('--label <label>', 'label for this CLI token')
    .option('--no-browser', 'do not attempt to open a browser automatically')
    .action(
      async (options: {
        apiUrl?: string;
        label?: string;
        browser?: boolean;
      }) => {
        await dependencies.cloudLogin({
          ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
          ...(options.label ? { label: options.label } : {}),
          openBrowser: options.browser !== false,
        });
      },
    );
};

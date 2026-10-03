import type { Command } from 'commander';

import type { LogoutResult } from '../cloud/operations.js';

export type LogoutCommandDependencies = {
  cloudLogout(): Promise<LogoutResult>;
  writeOut(value: string): void;
};

export const registerLogoutCommand = (
  program: Command,
  dependencies: LogoutCommandDependencies,
): void => {
  program
    .command('logout')
    .description('Sign out of STAK Cloud and remove the local credential')
    .action(async () => {
      const result = await dependencies.cloudLogout();
      if (!result.wasSignedIn) {
        dependencies.writeOut('You are not signed in.\n');
        return;
      }
      dependencies.writeOut(
        result.remoteRevoked
          ? 'Signed out. The server token was revoked and the local credential was removed.\n'
          : 'Signed out locally. Remote revocation could not be confirmed; the local credential was removed.\n',
      );
    });
};

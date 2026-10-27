import type { Command } from 'commander';

import { StackCompositionError } from '@stack/core';

import type { InstallCommand, PackageManager } from '../update/install.js';
import {
  channelFor,
  isNewerVersion,
  type ReleaseChannel,
} from '../update/version.js';

/** How the install child process ended: an exit code, or a spawn error code (e.g. ENOENT). */
export type InstallRunResult = { exitCode: number | null; errorCode?: string };

export type UpgradeCommandDependencies = {
  currentVersion: string;
  /** Newest published version on `channel`, straight from the registry (no cache). */
  latestVersion(channel: ReleaseChannel): Promise<string>;
  detectPackageManager(): PackageManager;
  installCommand(
    packageManager: PackageManager,
    channel: ReleaseChannel,
  ): InstallCommand;
  /** Runs the install with inherited stdio. Must resolve (not reject) on failure. */
  runInstall(install: InstallCommand): Promise<InstallRunResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export class UpgradeError extends StackCompositionError {
  constructor(
    code: 'registry-unavailable' | 'install-failed',
    message: string,
  ) {
    super(code, message);
    this.name = 'UpgradeError';
  }
}

// npm reports EACCES/EPERM by exiting with the (negative) errno: -13 → 243 on POSIX;
// on Windows EPERM is -4048 and EACCES is -4092 (or their unsigned 32-bit forms).
const PERMISSION_EXIT_CODES = new Set([
  243, -13, -4048, -4092, 4294963248, 4294963204,
]);

export const isPermissionFailure = (result: InstallRunResult): boolean =>
  result.errorCode === 'EACCES' ||
  result.errorCode === 'EPERM' ||
  (result.exitCode !== null && PERMISSION_EXIT_CODES.has(result.exitCode));

export const registerUpgradeCommand = (
  program: Command,
  dependencies: UpgradeCommandDependencies,
): void => {
  program
    .command('upgrade')
    .description('Update the STAK CLI to the newest version on your channel')
    .option('--dry-run', 'print the install command without running it')
    .option('-y, --yes', 'install without asking for confirmation')
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      const current = dependencies.currentVersion;
      const channel = channelFor(current);
      let latest: string;
      try {
        latest = await dependencies.latestVersion(channel);
      } catch (error) {
        throw new UpgradeError(
          'registry-unavailable',
          `Could not check the npm registry for the newest STAK version (${
            error instanceof Error ? error.message : String(error)
          }).\nCheck your connection and try again.`,
        );
      }

      dependencies.writeOut(
        `Current: ${current}\nLatest (${channel}): ${latest}\n`,
      );
      if (!isNewerVersion(latest, current)) {
        dependencies.writeOut('STAK is up to date.\n');
        return;
      }

      const install = dependencies.installCommand(
        dependencies.detectPackageManager(),
        channel,
      );
      if (options.dryRun) {
        dependencies.writeOut(
          `\nWould run: ${install.display}\nNo changes were made.\n`,
        );
        return;
      }
      dependencies.writeOut(`\nThis will run: ${install.display}\n`);
      if (
        !options.yes &&
        !(await dependencies.confirm('Install the update?'))
      ) {
        dependencies.writeOut('Cancelled. No changes were made.\n');
        return;
      }

      const result = await dependencies.runInstall(install);
      if (result.exitCode === 0 && result.errorCode === undefined) {
        dependencies.writeOut(`\nSTAK ${latest} installed.\n`);
        return;
      }
      const reason =
        result.errorCode !== undefined
          ? `could not start (${result.errorCode})`
          : `exited with code ${result.exitCode ?? 'unknown'}`;
      throw new UpgradeError(
        'install-failed',
        `The update ${reason}. Run it yourself:\n  ${install.display}` +
          (isPermissionFailure(result)
            ? '\nThis looks like a permissions error: run it from an administrator (Windows) or sudo shell.'
            : ''),
      );
    });
};

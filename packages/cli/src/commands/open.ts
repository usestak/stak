import type { Command } from 'commander';

/**
 * `stak open` (P4) — open the STAK web app in the browser with THIS machine selected, via
 * `…/overview?machine=<machineId>`. The machine id is the only thing in the URL; no token,
 * secret, or Memory ever is. It mutates no user state and makes no network call to open the
 * browser (web auth handles sign-in). Browser launch is injected so it is mockable in tests.
 */
export type OpenCommandDependencies = {
  /** This machine's STAK machine id; throws clearly when it cannot be determined. */
  machineId(): Promise<string>;
  /** The target web app Overview URL for a machine context (id URL-encoded). */
  openUrl(machineId: string): string;
  openBrowser(url: string): Promise<void>;
  writeOut(value: string): void;
};

export const registerOpenCommand = (
  program: Command,
  dependencies: OpenCommandDependencies,
): void => {
  program
    .command('open')
    .description('Open the STAK web app with this machine selected')
    .option('--print', 'print the URL instead of launching a browser')
    .action(async (options: { print?: boolean }) => {
      const machineId = await dependencies.machineId();
      const url = dependencies.openUrl(machineId);
      if (options.print) {
        dependencies.writeOut(`${url}\n`);
        return;
      }
      await dependencies.openBrowser(url);
      dependencies.writeOut(`Opening STAK for this machine…\n${url}\n`);
    });
};

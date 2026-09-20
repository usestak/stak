import type { Command } from 'commander';

import { AgentNotInstalledError } from '@stack/adapters';
import type { RemoteTrialResolution, TrialStackResolution } from '@stack/core';
import type {
  AgentDetection,
  TryExitResult,
  TryPreparationResult,
} from '@stack/spec';

import { renderTryDryRun, renderTryExit, renderTryReady } from '../ui/try.js';

export type AnyTrialResolution = TrialStackResolution | RemoteTrialResolution;

export type TryCommandDependencies = {
  detectCodex(): Promise<AgentDetection>;
  resolveTry(input: string): Promise<AnyTrialResolution>;
  preserveTry(trial: AnyTrialResolution): Promise<void>;
  prepareTry(trial: AnyTrialResolution): Promise<TryPreparationResult>;
  cleanupTry(preparation: TryPreparationResult): Promise<void>;
  launchTry(
    preparation: TryPreparationResult,
    detection: AgentDetection,
  ): Promise<TryExitResult>;
  writeOut(value: string): void;
};

export const registerTryCommand = (
  program: Command,
  dependencies: TryCommandDependencies,
) => {
  program
    .command('try <stack> [agent]')
    .description(
      'Run a local or public (@owner/name) Stack in an isolated scratch Codex session',
    )
    .option(
      '--dry-run',
      'resolve and inspect isolation without persistent mutation',
    )
    .option('--json', 'emit structured JSON (with --dry-run)')
    .action(
      async (
        input: string,
        agent: string | undefined,
        options: { dryRun?: boolean; json?: boolean },
      ) => {
        if (agent !== 'codex')
          throw new Error('Use: stack try <stack> -- codex');
        const detection = await dependencies.detectCodex();
        if (!detection.installed) throw new AgentNotInstalledError();
        const trial = await dependencies.resolveTry(input);
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify({ dryRun: true, detection, resolution: trial.resolved, mutation: { store: false, runtime: false, main: false, normalBindings: false } }, null, 2)}\n`,
          );
          return;
        }
        if (options.dryRun) {
          dependencies.writeOut(renderTryDryRun(trial.resolved));
          return;
        }
        await dependencies.preserveTry(trial);
        const preparation = await dependencies.prepareTry(trial);
        try {
          dependencies.writeOut(renderTryReady(preparation));
          const result = await dependencies.launchTry(preparation, detection);
          dependencies.writeOut(renderTryExit(result));
        } finally {
          await dependencies.cleanupTry(preparation);
        }
      },
    );
};

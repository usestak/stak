import type { Command } from 'commander';

import { AgentNotInstalledError } from '@stack/adapters';
import { StackCompositionError } from '@stack/core';
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
    // `agent` is REQUIRED (Codex-only in V0.1, but still required rather than
    // defaulted — matches `stak try <stak> -- codex`, see README/web onboarding).
    // A missing argument now fails via commander's own clean built-in validation
    // ("error: missing required argument 'agent'", exit 1) instead of reaching the
    // internal `agent !== 'codex'` check below as a raw, uncaught `Error` — which
    // previously surfaced as a full Node stack trace for ordinary CLI misuse.
    .command('try <stak> <agent>')
    .description(
      'Run a local or public (@owner/name) STAK in an isolated scratch Codex session',
    )
    .option(
      '--dry-run',
      'resolve and inspect isolation without persistent mutation',
    )
    .option('--json', 'emit structured JSON (with --dry-run)')
    .option('--verbose', 'show detailed isolation and runtime internals')
    .action(
      async (
        input: string,
        agent: string,
        options: { dryRun?: boolean; json?: boolean; verbose?: boolean },
      ) => {
        if (agent !== 'codex')
          throw new StackCompositionError(
            'try-unsupported-agent',
            `Unsupported agent: ${agent}. "stak try" is Codex-only in V0.1 — ` +
              'use: stak try <stak> -- codex',
          );
        const verbose = options.verbose === true;
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
          dependencies.writeOut(renderTryReady(preparation, { verbose }));
          const result = await dependencies.launchTry(preparation, detection);
          dependencies.writeOut(renderTryExit(result, { verbose }));
        } finally {
          await dependencies.cleanupTry(preparation);
        }
      },
    );
};

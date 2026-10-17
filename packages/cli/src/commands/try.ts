import type { Command } from 'commander';

import { AgentNotInstalledError } from '@stack/adapters';
import { StackCompositionError } from '@stack/core';
import type { RemoteTrialResolution, TrialStackResolution } from '@stack/core';
import { agentIdSchema } from '@stack/spec';
import type {
  AgentDetection,
  AgentId,
  TryExitResult,
  TryPreparationResult,
} from '@stack/spec';

import { agentLabel } from '../ui/format.js';
import { renderTryDryRun, renderTryExit, renderTryReady } from '../ui/try.js';

export type AnyTrialResolution = TrialStackResolution | RemoteTrialResolution;

export type TryCommandDependencies = {
  detectAgent(agent: AgentId): Promise<AgentDetection>;
  resolveTry(input: string): Promise<AnyTrialResolution>;
  preserveTry(trial: AnyTrialResolution): Promise<void>;
  prepareTry(
    agent: AgentId,
    trial: AnyTrialResolution,
  ): Promise<TryPreparationResult>;
  cleanupTry(agent: AgentId, preparation: TryPreparationResult): Promise<void>;
  launchTry(
    agent: AgentId,
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
    // `agent` is REQUIRED — matches `stak try <stak> -- codex|claude|cursor`.
    // A missing argument fails via commander's own clean built-in validation
    // ("error: missing required argument 'agent'", exit 1) instead of reaching the
    // internal agent-support check below as a raw, uncaught `Error` — which would
    // surface as a full Node stack trace for ordinary CLI misuse.
    .command('try <stak> <agent>')
    .description(
      'Run a local or public (@owner/name) STAK in an isolated Codex, Claude, or Cursor session',
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
        if (!agentIdSchema.safeParse(agent).success)
          throw new StackCompositionError(
            'try-unsupported-agent',
            `Unsupported agent: ${agent}. Run a STAK in an isolated Codex, ` +
              'Claude, or Cursor session — use: stak try <stak> -- ' +
              'codex|claude|cursor',
          );
        const agentId = agent as AgentId;
        const verbose = options.verbose === true;
        const detection = await dependencies.detectAgent(agentId);
        if (!detection.installed)
          throw new AgentNotInstalledError(agentLabel(agentId));
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
          dependencies.writeOut(renderTryDryRun(trial.resolved, agentId));
          return;
        }
        await dependencies.preserveTry(trial);
        const preparation = await dependencies.prepareTry(agentId, trial);
        try {
          dependencies.writeOut(
            renderTryReady(preparation, agentId, { verbose }),
          );
          const result = await dependencies.launchTry(
            agentId,
            preparation,
            detection,
          );
          dependencies.writeOut(renderTryExit(result, agentId, { verbose }));
        } finally {
          await dependencies.cleanupTry(agentId, preparation);
        }
      },
    );
};

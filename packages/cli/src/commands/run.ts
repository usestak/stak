import type { Command } from 'commander';

import { AgentNotInstalledError, BindingConflictError } from '@stack/adapters';
import type {
  AgentDetection,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  LaunchResult,
  ResolvedLocalEnvironment,
} from '@stack/spec';

import { renderBindingPlan } from '../ui/run.js';

export type RunCommandDependencies = {
  loadRunEnvironment(): Promise<ResolvedLocalEnvironment>;
  detectCodex(): Promise<AgentDetection>;
  planCodexBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingPlan>;
  applyCodexBindings(
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult>;
  verifyCodexBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification>;
  launchCodex(): Promise<LaunchResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const mutationStates = new Set(['add', 'update-managed', 'managed-drift']);

export const registerRunCommand = (
  program: Command,
  dependencies: RunCommandDependencies,
): void => {
  program
    .command('run <agent>')
    .description('Expose main to an agent and launch it (Phase 4: Codex only)')
    .option('--dry-run', 'preview bindings without mutation or launch')
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'approve safe binding mutations non-interactively')
    .action(
      async (
        agent: string,
        options: { dryRun?: boolean; json?: boolean; yes?: boolean },
      ) => {
        if (agent !== 'codex') throw new Error('Phase 4 supports Codex only.');
        const environment = await dependencies.loadRunEnvironment();
        const detection = await dependencies.detectCodex();
        if (!detection.installed) throw new AgentNotInstalledError();
        const plan = await dependencies.planCodexBindings(environment);
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify({ detection, plan, dryRun: true }, null, 2)}\n`,
          );
          return;
        }
        dependencies.writeOut(renderBindingPlan(plan, options.dryRun === true));
        if (options.dryRun) return;
        if (plan.blocking) throw new BindingConflictError();
        const needsMutation = plan.operations.some((item) =>
          mutationStates.has(item.state),
        );
        if (
          needsMutation &&
          !options.yes &&
          !(await dependencies.confirm('Apply bindings and launch Codex?'))
        ) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        if (needsMutation) {
          await dependencies.applyCodexBindings(plan, environment.machineId);
          const verification =
            await dependencies.verifyCodexBindings(environment);
          if (!verification.healthy)
            throw new BindingConflictError(
              'Codex Skill binding verification failed.',
            );
          dependencies.writeOut('Bindings applied and verified.\n\n');
        }
        dependencies.writeOut('Launching Codex...\n');
        await dependencies.launchCodex();
      },
    );
};

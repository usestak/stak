import type { Command } from 'commander';

import { AgentNotInstalledError, BindingConflictError } from '@stack/adapters';
import type {
  AgentId,
  AgentDetection,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  LaunchResult,
  ResolvedLocalEnvironment,
} from '@stack/spec';

import {
  isAgentExportId,
  safelyExportAgentMemory,
  type AgentExportId,
  type AgentExportReport,
} from '../memory/agent-export-ops.js';
import { renderAgentExportNotes } from '../ui/agent-memory.js';
import { agentLabel, block, skills } from '../ui/format.js';
import {
  bindingCountLines,
  renderBindingPlan,
  renderRunDryRun,
  summarizeBinding,
} from '../ui/run.js';

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
  detectAgent?(agent: AgentId): Promise<AgentDetection>;
  planAgentBindings?(
    agent: AgentId,
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingPlan>;
  applyAgentBindings?(
    agent: AgentId,
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult>;
  verifyAgentBindings?(
    agent: AgentId,
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification>;
  launchAgent?(agent: AgentId): Promise<LaunchResult>;
  /** Spec 2026-10-28 §7: `stak run codex|cursor` turns on project Memory
   * sharing for that agent and writes its files right away. Optional. */
  enableAgentMemory?(agent: AgentExportId): Promise<AgentExportReport>;
  /** Runs `fn` holding the Memory lock (spec 2026-10-25). `stak run` takes it
   * around the Memory export only, with a short wait (`timeoutMs`). Optional;
   * when absent, `fn` runs directly. */
  withMemoryLock?<T>(
    command: string,
    fn: () => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

/** How long `stak run` waits for a busy Memory lock before launching without
 * the export (the same short wait as the post-command check-in). */
export const RUN_MEMORY_LOCK_TIMEOUT_MS = 2_000;

const mutationStates = new Set([
  'add',
  'update-managed',
  'managed-drift',
  'remove-managed',
]);

export const registerRunCommand = (
  program: Command,
  dependencies: RunCommandDependencies,
): void => {
  program
    .command('run <agent>')
    .description('Set up Codex, Cursor, or Claude with your STAK and launch it')
    .option('--dry-run', 'preview changes without setting up or launching')
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'approve safe changes non-interactively')
    .option('--verbose', 'show detailed binding internals')
    .option('--no-memory', "don't share project Memory with Codex or Cursor")
    .action(
      async (
        agent: string,
        options: {
          dryRun?: boolean;
          json?: boolean;
          yes?: boolean;
          verbose?: boolean;
          memory?: boolean;
        },
      ) => {
        if (!['codex', 'cursor', 'claude'].includes(agent))
          throw new Error(`Unsupported agent: ${agent}`);
        const agentId = agent as AgentId;
        const agentName = agentLabel(agentId);
        const verbose = options.verbose === true;
        const environment = await dependencies.loadRunEnvironment();
        const detection = dependencies.detectAgent
          ? await dependencies.detectAgent(agentId)
          : await dependencies.detectCodex();
        if (!detection.installed)
          throw new AgentNotInstalledError(
            agentId === 'cursor' ? 'Cursor Agent' : agentName,
          );
        const plan = dependencies.planAgentBindings
          ? await dependencies.planAgentBindings(agentId, environment)
          : await dependencies.planCodexBindings(environment);
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify({ detection, plan, dryRun: true }, null, 2)}\n`,
          );
          return;
        }
        if (options.dryRun) {
          dependencies.writeOut(
            verbose ? renderBindingPlan(plan, true) : renderRunDryRun(plan),
          );
          return;
        }
        if (verbose) dependencies.writeOut(renderBindingPlan(plan, false));
        if (plan.blocking) throw new BindingConflictError();
        const summary = summarizeBinding(plan);
        const needsMutation = plan.operations.some((item) =>
          mutationStates.has(item.state),
        );
        // Show what will change before asking to proceed.
        if (!verbose && summary.mutating)
          dependencies.writeOut(
            block([
              `${summary.firstSetup ? 'Setting up' : 'Updating'} ${agentName}...`,
              '',
              ...(summary.firstSetup
                ? [`${skills(summary.added)} added.`]
                : bindingCountLines(summary)),
            ]),
          );
        if (
          needsMutation &&
          !options.yes &&
          !(await dependencies.confirm(
            `Apply changes and launch ${agentName}?`,
          ))
        ) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        if (needsMutation) {
          if (dependencies.applyAgentBindings)
            await dependencies.applyAgentBindings(
              agentId,
              plan,
              environment.machineId,
            );
          else
            await dependencies.applyCodexBindings(plan, environment.machineId);
          const verification = dependencies.verifyAgentBindings
            ? await dependencies.verifyAgentBindings(agentId, environment)
            : await dependencies.verifyCodexBindings(environment);
          if (!verification.healthy)
            throw new BindingConflictError(
              `${agentName} Skill binding verification failed.`,
            );
          dependencies.writeOut(
            verbose
              ? 'Bindings applied and verified.\n\n'
              : `\n${agentName} is ready.\n\n`,
          );
        } else if (!verbose)
          dependencies.writeOut(
            `${agentName} is already set up with ${skills(summary.total)}.\n\n`,
          );
        // Spec 2026-10-28 §7: share project Memory with Codex/Cursor (Claude
        // already reads it). The Memory lock is held around the export only;
        // a busy lock or any export problem is a note, never a failure (§8).
        const enableAgentMemory = dependencies.enableAgentMemory;
        if (
          options.memory !== false &&
          isAgentExportId(agentId) &&
          enableAgentMemory
        ) {
          const report = await safelyExportAgentMemory(() =>
            dependencies.withMemoryLock
              ? dependencies.withMemoryLock(
                  'stak run',
                  () => enableAgentMemory.call(dependencies, agentId),
                  { timeoutMs: RUN_MEMORY_LOCK_TIMEOUT_MS },
                )
              : enableAgentMemory.call(dependencies, agentId),
          );
          const notes = renderAgentExportNotes(report, 'enable');
          if (notes) dependencies.writeOut(notes);
        }
        dependencies.writeOut(`Launching ${agentName}...\n`);
        if (dependencies.launchAgent) await dependencies.launchAgent(agentId);
        else await dependencies.launchCodex();
      },
    );
};

import type { Command } from 'commander';

import {
  LocalEnvironmentConflictError,
  RemoteEnvironmentConflictError,
} from '@stack/cloud-client';
import { StackCompositionError, type ApplyPushResult, type PushPlan } from '@stack/core';

import {
  pushFailed,
  pushPlanJson,
  renderCombinedPushResult,
  renderPushPlan,
  type MemoryPushOutcome,
  type PushMemoryOutcome,
  type PushSkillOutcome,
} from '../ui/cloud.js';

export type MemoryPushPreflight = { blocked: boolean; reason?: string };

export type PushCommandDependencies = {
  cloudPreparePush(): Promise<PushPlan>;
  cloudApplyPush(plan: PushPlan): Promise<ApplyPushResult>;
  /**
   * Read-only check for a predictable Memory/Cloud conflict (e.g. this machine's local
   * Memory was recovered from an older Cloud generation than the current latest). A
   * `blocked` preflight stops push BEFORE mutating either domain — Skills included.
   * Optional so existing Skills-only push wiring/tests keep working unchanged.
   */
  memoryPushPreflight?(): Promise<MemoryPushPreflight>;
  /**
   * Upload whatever Memory is ALREADY staged (never rescans native Memory or stages it —
   * that's `stak add .`'s job; this is push, not an implicit add).
   */
  applyMemoryPush?(): Promise<MemoryPushOutcome>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

export const registerPushCommand = (
  program: Command,
  dependencies: PushCommandDependencies,
): void => {
  program
    .command('push')
    .description(
      'Push main (Skills + Memory) to STAK Cloud, creating a new version automatically',
    )
    .option('--dry-run', 'preview the push without uploading or committing')
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'create the cloud version non-interactively')
    .option('--verbose', 'show detailed cloud internals')
    .action(
      async (options: {
        dryRun?: boolean;
        json?: boolean;
        yes?: boolean;
        verbose?: boolean;
      }) => {
        const verbose = options.verbose === true;
        // The Memory preflight is read-only and independent of the Skills plan, so its
        // Cloud round trips overlap with planning instead of following it. Its outcome is
        // still only acted on after the Skills conflict check, preserving error priority.
        const memoryPreflightPromise =
          dependencies.memoryPushPreflight && !options.json
            ? dependencies.memoryPushPreflight()
            : Promise.resolve<MemoryPushPreflight>({ blocked: false });
        memoryPreflightPromise.catch(() => undefined);
        const plan = await dependencies.cloudPreparePush();
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(pushPlanJson(plan), null, 2)}\n`,
          );
          return;
        }
        // A synchronization conflict blocks push, and --yes never bypasses it.
        if (plan.conflict)
          throw plan.conflict.kind === 'remote-newer'
            ? new RemoteEnvironmentConflictError(plan.conflict.message)
            : new LocalEnvironmentConflictError(plan.conflict.message);
        const memoryPreflight = await memoryPreflightPromise;
        // Preflight for BOTH domains completes before either is mutated — a predictable
        // Memory conflict stops the Skill push too, even though Skills had none.
        if (memoryPreflight.blocked)
          throw new LocalEnvironmentConflictError(
            memoryPreflight.reason ??
              'Memory has a predictable conflict with STAK Cloud. Resolve it before pushing.',
          );
        if (options.dryRun) {
          dependencies.writeOut(renderPushPlan(plan, true, { verbose }));
          return;
        }
        if (plan.noop && !dependencies.applyMemoryPush) {
          dependencies.writeOut(renderPushPlan(plan, false, { verbose }));
          return;
        }
        if (!options.yes && !(await dependencies.confirm('Push main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        dependencies.writeOut('Pushing main...\n\n');

        // Skills and Memory are independent domains with their own Cloud state, so they
        // upload concurrently; each still reports its own outcome.
        const applySkills = async (): Promise<PushSkillOutcome> => {
          if (plan.noop) return { status: 'noop' };
          try {
            return { status: 'applied', result: await dependencies.cloudApplyPush(plan) };
          } catch (error) {
            return {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const applyMemory = async (): Promise<PushMemoryOutcome> => {
          if (!dependencies.applyMemoryPush) return { status: 'not-attempted' };
          try {
            return { status: 'applied', outcome: await dependencies.applyMemoryPush() };
          } catch (error) {
            return {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const [skill, memory] = await Promise.all([applySkills(), applyMemory()]);

        dependencies.writeOut(renderCombinedPushResult(skill, memory));
        // A runtime/network failure in either domain after apply began is partial
        // success, not total failure — report it clearly above, then fail the command.
        // Never claim "Cloud is up to date" in this path (renderCombinedPushResult
        // never prints "Push complete." when pushFailed is true).
        if (pushFailed(skill, memory))
          throw new StackCompositionError(
            'push-partial-failure',
            'Push did not fully succeed — see the report above for which domain failed.',
          );
      },
    );
};

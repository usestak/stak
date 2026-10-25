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

/** `note`: a one-line notice printed when the push proceeds (spec §8.5: a
 * rollback published by an ordinary push is announced, never silent). */
export type MemoryPushPreflight = { blocked: boolean; reason?: string; note?: string };

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
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const runDirectly = async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn();

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
        const memoryPreflight = dependencies.memoryPushPreflight
          ? await dependencies.memoryPushPreflight()
          : { blocked: false };
        // Preflight for BOTH domains completes before either is mutated — a predictable
        // Memory conflict stops the Skill push too, even though Skills had none.
        if (memoryPreflight.blocked)
          throw new LocalEnvironmentConflictError(
            memoryPreflight.reason ??
              'Memory has a predictable conflict with STAK Cloud. Resolve it before pushing.',
          );
        if (memoryPreflight.note) dependencies.writeOut(`${memoryPreflight.note}\n`);
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

        let skill: PushSkillOutcome;
        if (plan.noop) skill = { status: 'noop' };
        else
          try {
            skill = { status: 'applied', result: await dependencies.cloudApplyPush(plan) };
          } catch (error) {
            skill = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

        // The Memory part holds the Memory lock (spec 2026-10-25 §3.2); Skills above run
        // outside it. The preflight is read again under the lock so the write acts on
        // the state it checked. A busy lock (MemoryLockError) lands in the catch below
        // and reports Memory FAILED with the lock message, like any Memory failure.
        let memory: PushMemoryOutcome;
        const applyMemoryPush = dependencies.applyMemoryPush;
        if (!applyMemoryPush) memory = { status: 'not-attempted' };
        else
          try {
            const lock = dependencies.withMemoryLock ?? runDirectly;
            memory = await lock('stak push', async (): Promise<PushMemoryOutcome> => {
              const recheck = dependencies.memoryPushPreflight
                ? await dependencies.memoryPushPreflight()
                : { blocked: false };
              if (recheck.blocked)
                return {
                  status: 'failed',
                  error:
                    recheck.reason ??
                    'Memory has a predictable conflict with STAK Cloud. Resolve it before pushing.',
                };
              return { status: 'applied', outcome: await applyMemoryPush.call(dependencies) };
            });
          } catch (error) {
            memory = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

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

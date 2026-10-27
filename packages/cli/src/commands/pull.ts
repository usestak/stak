import type { Command } from 'commander';

import { LocalEnvironmentConflictError } from '@stack/cloud-client';
import { MemoryLockError } from '@stack/memory';
import {
  StackCompositionError,
  type ApplyPullResult,
  type PullPlan,
} from '@stack/core';

import type { CloudRecoverOutcome } from '../memory/cloud-ops.js';
import type { CanonicalPullOutcome } from '../memory/canonical-ops.js';
import {
  pullFailed,
  pullPlanJson,
  renderCombinedPullResult,
  renderProjectMemoryOnlyPull,
  renderPullPlan,
  type PullCanonicalOutcome,
  type PullMemoryOutcome,
  type PullSkillOutcome,
} from '../ui/cloud.js';

export type MemoryPullPreflight = { eligible: boolean; reason?: string };

export type PullCommandDependencies = {
  cloudPreparePull(): Promise<PullPlan>;
  cloudApplyPull(plan: PullPlan): Promise<ApplyPullResult>;
  /**
   * Read-only: whether it is safe to auto-recover Memory as part of this pull. Eligible
   * ONLY on a genuinely fresh machine (no local Memory manifest yet) — an established
   * machine's Memory is never silently overwritten by `stak pull`; `stak memory recover`
   * remains available for an explicit, deliberate recovery. Optional so existing
   * Skills-only pull wiring/tests keep working unchanged.
   */
  memoryPullPreflight?(): Promise<MemoryPullPreflight>;
  applyMemoryPull?(): Promise<CloudRecoverOutcome>;
  /**
   * Canonical (Project) Memory's own pull (Task 13) — runs UNCONDITIONALLY, never
   * gated by `memoryPullPreflight` (which only guards the legacy fresh-machine
   * full-recover path above). Merges in whatever Cloud has and materializes it into
   * native files; never publishes. Optional so existing Skills-only pull tests keep
   * working unchanged. Wrapped defensively below — a failure here never throws past
   * this command.
   */
  applyCanonicalPull?(): Promise<CanonicalPullOutcome>;
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const runDirectly = async <T>(
  _command: string,
  fn: () => Promise<T>,
): Promise<T> => fn();

export const registerPullCommand = (
  program: Command,
  dependencies: PullCommandDependencies,
): void => {
  program
    .command('pull')
    .description(
      'Pull the latest main (Skills + Memory) from STAK Cloud — the normal new-machine recovery path',
    )
    .option(
      '--dry-run',
      'preview the pull without downloading or mutating main',
    )
    .option('--json', 'emit structured JSON for dry-run')
    .option('--yes', 'restore local main non-interactively')
    .option('--verbose', 'show detailed cloud internals')
    .action(
      async (options: {
        dryRun?: boolean;
        json?: boolean;
        yes?: boolean;
        verbose?: boolean;
      }) => {
        const verbose = options.verbose === true;
        const plan = await dependencies.cloudPreparePull();
        if (options.json) {
          if (!options.dryRun)
            throw new Error('--json currently requires --dry-run.');
          dependencies.writeOut(
            `${JSON.stringify(pullPlanJson(plan), null, 2)}\n`,
          );
          return;
        }
        // A local conflict blocks pull, and --yes never bypasses it.
        if (plan.conflict)
          throw new LocalEnvironmentConflictError(plan.conflict.message);
        if (options.dryRun) {
          dependencies.writeOut(renderPullPlan(plan, { verbose }));
          return;
        }
        const readMemoryPreflight = async (): Promise<MemoryPullPreflight> =>
          dependencies.memoryPullPreflight
            ? await dependencies.memoryPullPreflight()
            : { eligible: false };
        // Only a Skills no-op needs the Memory preflight up front, to decide whether
        // there is a fresh-machine recover to confirm. The decision that acts on it is
        // made from a fresh read under the Memory lock.
        if (plan.mode === 'noop' && !(await readMemoryPreflight()).eligible) {
          const applyCanonicalPull = dependencies.applyCanonicalPull;
          if (!applyCanonicalPull) {
            dependencies.writeOut(renderPullPlan(plan, { verbose }));
            return;
          }
          // Established machine, no Skills changes: Project Memory still syncs on every
          // `stak pull` (a merge; local changes are kept, conflicts become pending),
          // so there is nothing to confirm. Runs under the Memory lock.
          let canonicalMemory: PullCanonicalOutcome = {
            status: 'not-attempted',
          };
          let lockError: string | undefined;
          try {
            canonicalMemory = await (
              dependencies.withMemoryLock ?? runDirectly
            )('stak pull', async (): Promise<PullCanonicalOutcome> => {
              // Re-read under the lock: a machine that became fresh meanwhile must
              // not run the canonical pull's migration (Task 13 Important-8).
              if ((await readMemoryPreflight()).eligible)
                return { status: 'not-attempted' };
              try {
                return {
                  status: 'applied',
                  outcome: await applyCanonicalPull.call(dependencies),
                };
              } catch (error) {
                return {
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            });
          } catch (error) {
            if (!(error instanceof MemoryLockError)) throw error;
            lockError = error.message;
          }
          const rendered = renderProjectMemoryOnlyPull(
            canonicalMemory,
            lockError,
          );
          // Nothing changed: the same message as before (verbose keeps its detail).
          dependencies.writeOut(
            verbose && rendered === renderPullPlan(plan)
              ? renderPullPlan(plan, { verbose })
              : rendered,
          );
          if (lockError)
            throw new StackCompositionError(
              'pull-partial-failure',
              'Pull did not fully succeed — see the report above for which domain failed.',
            );
          return;
        }
        if (!options.yes && !(await dependencies.confirm('Pull main?'))) {
          dependencies.writeOut('Cancelled. No changes were made.\n');
          return;
        }
        dependencies.writeOut('Pulling main...\n\n');

        let skill: PullSkillOutcome;
        if (plan.mode === 'noop') skill = { status: 'noop' };
        else
          try {
            skill = {
              status: 'applied',
              result: await dependencies.cloudApplyPull(plan),
            };
          } catch (error) {
            skill = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

        // All Memory work (preflight read, fresh-machine recover, canonical pull) runs
        // under the Memory lock (spec 2026-10-25 §3.2); Skills above run outside it.
        const memoryPart = async (): Promise<{
          memory: PullMemoryOutcome;
          canonicalMemory: PullCanonicalOutcome;
        }> => {
          const memoryPreflight = await readMemoryPreflight();
          let memory: PullMemoryOutcome;
          if (!memoryPreflight.eligible || !dependencies.applyMemoryPull)
            memory = memoryPreflight.reason
              ? { status: 'skipped', reason: memoryPreflight.reason }
              : { status: 'not-attempted' };
          else
            try {
              memory = {
                status: 'applied',
                outcome: await dependencies.applyMemoryPull(),
              };
            } catch (error) {
              memory = {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              };
            }

          // Task 13 Important-8: a fresh machine whose full recover attempt was
          // ATTEMPTED but did NOT succeed (Protected locked, no backup, a network
          // error, …) must not run the canonical pull's `migrateLocalStore` here —
          // that call writes `manifests/current.json` (even with zero items, via
          // its "slim to global" step) and the completion marker, which would make
          // `memoryPullPreflight`'s "no local manifest yet" fresh-machine check
          // read this machine as already established on the VERY NEXT `stak pull`,
          // permanently disabling auto-recovery after a single transient failure.
          // An established machine (not eligible for fresh recover at all) is
          // unaffected — canonical pull still runs for it every time, as normal.
          const freshRecoverAttemptedButDidNotSucceed =
            memoryPreflight.eligible &&
            !!dependencies.applyMemoryPull &&
            !(
              memory.status === 'applied' &&
              memory.outcome.status === 'recovered'
            );

          let canonicalMemory: PullCanonicalOutcome;
          if (
            !dependencies.applyCanonicalPull ||
            freshRecoverAttemptedButDidNotSucceed
          )
            canonicalMemory = { status: 'not-attempted' };
          else
            try {
              canonicalMemory = {
                status: 'applied',
                outcome: await dependencies.applyCanonicalPull(),
              };
            } catch (error) {
              canonicalMemory = {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              };
            }
          return { memory, canonicalMemory };
        };

        let memory: PullMemoryOutcome = { status: 'not-attempted' };
        let canonicalMemory: PullCanonicalOutcome = { status: 'not-attempted' };
        const hasMemoryWork =
          dependencies.memoryPullPreflight !== undefined ||
          dependencies.applyMemoryPull !== undefined ||
          dependencies.applyCanonicalPull !== undefined;
        if (hasMemoryWork)
          try {
            ({ memory, canonicalMemory } = await (
              dependencies.withMemoryLock ?? runDirectly
            )('stak pull', memoryPart));
          } catch (error) {
            // A busy lock stops only the Memory part: it reports FAILED with the lock
            // message, like any Memory failure, and changed nothing in Memory.
            if (!(error instanceof MemoryLockError)) throw error;
            memory = { status: 'failed', error: error.message };
          }

        dependencies.writeOut(
          renderCombinedPullResult(skill, memory, canonicalMemory),
        );
        if (pullFailed(skill, memory))
          throw new StackCompositionError(
            'pull-partial-failure',
            'Pull did not fully succeed — see the report above for which domain failed.',
          );
      },
    );
};

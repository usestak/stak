import type { Command } from 'commander';

import { LocalEnvironmentConflictError } from '@stack/cloud-client';
import { StackCompositionError, type ApplyPullResult, type PullPlan } from '@stack/core';

import type { CloudRecoverOutcome } from '../memory/cloud-ops.js';
import type { CanonicalPullOutcome } from '../memory/canonical-ops.js';
import {
  pullFailed,
  pullPlanJson,
  renderCombinedPullResult,
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
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

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
        const memoryPreflight = dependencies.memoryPullPreflight
          ? await dependencies.memoryPullPreflight()
          : { eligible: false };
        if (options.dryRun) {
          dependencies.writeOut(renderPullPlan(plan, { verbose }));
          return;
        }
        if (plan.mode === 'noop' && !memoryPreflight.eligible) {
          dependencies.writeOut(renderPullPlan(plan, { verbose }));
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
            skill = { status: 'applied', result: await dependencies.cloudApplyPull(plan) };
          } catch (error) {
            skill = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

        let memory: PullMemoryOutcome;
        if (!memoryPreflight.eligible || !dependencies.applyMemoryPull)
          memory = memoryPreflight.reason
            ? { status: 'skipped', reason: memoryPreflight.reason }
            : { status: 'not-attempted' };
        else
          try {
            memory = { status: 'applied', outcome: await dependencies.applyMemoryPull() };
          } catch (error) {
            memory = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

        let canonicalMemory: PullCanonicalOutcome;
        if (!dependencies.applyCanonicalPull) canonicalMemory = { status: 'not-attempted' };
        else
          try {
            canonicalMemory = { status: 'applied', outcome: await dependencies.applyCanonicalPull() };
          } catch (error) {
            canonicalMemory = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }

        dependencies.writeOut(renderCombinedPullResult(skill, memory, canonicalMemory));
        if (pullFailed(skill, memory))
          throw new StackCompositionError(
            'pull-partial-failure',
            'Pull did not fully succeed — see the report above for which domain failed.',
          );
      },
    );
};

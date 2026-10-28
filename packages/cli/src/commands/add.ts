import type { Command } from 'commander';

import type { SkillAddProposal } from '@stack/core';
import type { ScanResult } from '@stack/spec';

import {
  safelyExportAgentMemory,
  type AgentExportReport,
} from '../memory/agent-export-ops.js';
import { renderSkillAdd, type StagedMemorySummary } from '../ui/add.js';
import { agentExportNotes } from '../ui/agent-memory.js';

export type AddCommandDependencies = {
  scan(options: { project: boolean }): Promise<ScanResult>;
  prepareAdd(
    scanResult: ScanResult,
    selectors: string[] | '.',
  ): Promise<SkillAddProposal>;
  applyAdd(proposal: SkillAddProposal): Promise<unknown>;
  /**
   * `stak add .` also stages all eligible current Memory (and, via the same local
   * registry sync, portable Project state) into the local Memory manifest — never
   * contacting Cloud. Only called for `add .`, never for a single `add <skill>`.
   */
  stageMemory?(): Promise<StagedMemorySummary>;
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
  /** Spec 2026-10-28 §7: refresh every enabled agent's Memory file. Called at
   * the end of `stak add .`'s locked span. Optional; never fails the command. */
  exportAgentMemory?(): Promise<AgentExportReport>;
  writeOut(value: string): void;
};

const runDirectly = async <T>(
  _command: string,
  fn: () => Promise<T>,
): Promise<T> => fn();

export const registerAddCommand = (
  program: Command,
  dependencies: AddCommandDependencies,
): void => {
  program
    .command('add <selector...>')
    .description(
      'Stage untracked or modified Skills (and, with `.`, Memory/Projects) into main, like `git add`',
    )
    .action(async (selectors: string[]) => {
      const addAll = selectors.includes('.');
      const stageMemory = addAll ? dependencies.stageMemory : undefined;
      const stage = async () => {
        const scanResult = await dependencies.scan({ project: false });
        const proposal = await dependencies.prepareAdd(
          scanResult,
          addAll ? '.' : selectors,
        );
        if (proposal.targets.length > 0) await dependencies.applyAdd(proposal);
        const memory = stageMemory
          ? await stageMemory.call(dependencies)
          : undefined;
        // Spec 2026-10-28 §7: refresh the agent files inside the same lock.
        const agentMemory = stageMemory
          ? await safelyExportAgentMemory(
              dependencies.exportAgentMemory?.bind(dependencies),
            )
          : undefined;
        return { proposal, memory, agentMemory };
      };
      // `stak add .` holds the Memory lock across its whole staging (spec 2026-10-25
      // §3.2/§3.3): a busy lock stops it before anything changes, Skills included, so a
      // rerun stages both together. A single `add <skill>` never touches Memory.
      const lock = stageMemory
        ? (dependencies.withMemoryLock ?? runDirectly)
        : runDirectly;
      const { proposal, memory, agentMemory } = await lock('stak add', stage);
      dependencies.writeOut(
        renderSkillAdd(proposal, {
          ...(memory ? { memory } : {}),
          agentNotes: agentExportNotes(agentMemory),
        }),
      );
    });
};

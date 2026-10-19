import type { Command } from 'commander';

import type { SkillAddProposal } from '@stack/core';
import type { ScanResult } from '@stack/spec';

import { renderSkillAdd, type StagedMemorySummary } from '../ui/add.js';

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
  writeOut(value: string): void;
};

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
      const scanResult = await dependencies.scan({ project: false });
      const proposal = await dependencies.prepareAdd(
        scanResult,
        addAll ? '.' : selectors,
      );
      if (proposal.targets.length > 0) await dependencies.applyAdd(proposal);
      const memory =
        addAll && dependencies.stageMemory
          ? await dependencies.stageMemory()
          : undefined;
      dependencies.writeOut(
        renderSkillAdd(proposal, { ...(memory ? { memory } : {}) }),
      );
    });
};

import type { Command } from 'commander';

import type { AgentId } from '@stack/spec';
import type { SetSkillPausedResult } from '@stack/core';
import type { SkillCheckResult } from '../skill-check-runner.js';

/**
 * `stak skill` — the Skill lifecycle on this machine (P2).
 *
 *   stak skill update [<skill>]   install/reconcile APPROVED desired versions onto THIS machine
 *   stak skill pause  <skill>     stop projecting a Skill to agents (keeps version/provenance)
 *   stak skill resume <skill>     project it again
 *   stak skill check  [<skill>]   check Skill sources for updates (P5a §5a)
 *
 * `update` changes installed machine state → it checks in on success. `pause`/`resume` change
 * only machine-local DESIRED state (the lock's `paused` flag); the projection effect is realised
 * on the next `run`/`skill update`, so they do NOT check in (desired ≠ installed). `check`
 * contacts each checkable Skill's source remote and reports the result to Cloud — it never
 * approves, installs, pauses, or resumes anything, so it does NOT check in either.
 */
export type SkillUpdateAgentResult = {
  agent: AgentId;
  applied: number;
  removed: number;
  unchanged: number;
};
export type SkillUpdateResult =
  | {
      status: 'ok';
      selector?: string;
      entryId?: string;
      agents: SkillUpdateAgentResult[];
    }
  | { status: 'no-environment' }
  | { status: 'not-found' }
  | { status: 'ambiguous'; matches: string[] };

export type SkillCommandDependencies = {
  skillUpdate(options: { selector?: string }): Promise<SkillUpdateResult>;
  skillPause(options: { selector: string }): Promise<SetSkillPausedResult>;
  skillResume(options: { selector: string }): Promise<SetSkillPausedResult>;
  skillCheck(options: { selector?: string }): Promise<SkillCheckResult>;
  writeOut(value: string): void;
};

const renderUpdate = (result: SkillUpdateResult): string => {
  switch (result.status) {
    case 'no-environment':
      return 'main does not exist. Run `stak init` first.\n';
    case 'not-found':
      return 'No matching Skill. Run `stak status` to see Skills STAK knows about.\n';
    case 'ambiguous':
      return (
        `That selector matches ${result.matches.length} Skills with the same name. ` +
        'Use a stable Skill id instead.\n'
      );
    case 'ok': {
      const target = result.selector ? ` ${result.selector}` : '';
      if (result.agents.length === 0)
        return `No agents are installed on this machine, so there is nothing to update${target}.\n`;
      const lines = [`Updated${target} on this machine:`, ''];
      for (const agent of result.agents)
        lines.push(
          `  ${agent.agent}: ${agent.applied} installed/updated, ${agent.removed} removed, ${agent.unchanged} unchanged`,
        );
      lines.push('');
      return lines.join('\n');
    }
  }
};

const renderPaused = (
  result: SetSkillPausedResult,
  target: 'paused' | 'active',
): string => {
  switch (result.status) {
    case 'not-found':
      return 'No matching Skill. Run `stak status` to see Skills STAK knows about.\n';
    case 'ambiguous':
      return (
        `That selector matches ${result.matches.length} Skills with the same name. ` +
        'Use a stable Skill id instead.\n'
      );
    case 'ok': {
      const verb = target === 'paused' ? 'Paused' : 'Resumed';
      if (!result.changed)
        return `${result.name} is already ${target === 'paused' ? 'paused' : 'active'}.\n`;
      // Be explicit that this is a DESIRED-state change only: the agent files already on this
      // machine are not touched until the next reconciliation (run / skill update).
      return (
        `${verb} ${result.name} in STAK.\n` +
        'Your agent files are unchanged until you reconcile this machine. ' +
        'Run `stak run` (or `stak skill update`) to apply it here.\n'
      );
    }
  }
};

const renderCheck = (result: SkillCheckResult): string => {
  if (result.checked.length === 0) return 'No Skills to check.\n';
  const lines: string[] = [];
  for (const entry of result.checked) {
    switch (entry.outcome) {
      case 'no-update':
        lines.push(`${entry.name}: No update.`);
        break;
      case 'update-available':
        lines.push(
          entry.exceedsBounds
            ? `${entry.name}: Update available, but it exceeds STAK's review limits and can't be reviewed here.`
            : `${entry.name}: Update available.`,
        );
        break;
      case 'cannot-check':
        lines.push(`${entry.name}: Can't check for updates from this source.`);
        break;
      case 'check-failed':
        lines.push(
          `${entry.name}: Check failed: ${entry.checkFailedReason ?? 'unknown error'}`,
        );
        break;
    }
  }
  lines.push('');
  return lines.join('\n');
};

export const registerSkillCommand = (
  program: Command,
  dependencies: SkillCommandDependencies,
): void => {
  const skill = program
    .command('skill')
    .description('Manage the Skill lifecycle on this machine');

  skill
    .command('update [skill]')
    .description('Install approved Skill versions on this machine')
    .option('--json', 'emit structured JSON only')
    .action(
      async (selector: string | undefined, options: { json?: boolean }) => {
        const result = await dependencies.skillUpdate(
          selector ? { selector } : {},
        );
        dependencies.writeOut(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : renderUpdate(result),
        );
      },
    );

  skill
    .command('pause <skill>')
    .description(
      'Stop projecting a Skill to agents (keeps its version and provenance)',
    )
    .option('--json', 'emit structured JSON only')
    .action(async (selector: string, options: { json?: boolean }) => {
      const result = await dependencies.skillPause({ selector });
      dependencies.writeOut(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderPaused(result, 'paused'),
      );
    });

  skill
    .command('resume <skill>')
    .description('Project a paused Skill to agents again')
    .option('--json', 'emit structured JSON only')
    .action(async (selector: string, options: { json?: boolean }) => {
      const result = await dependencies.skillResume({ selector });
      dependencies.writeOut(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderPaused(result, 'active'),
      );
    });

  skill
    .command('check [skill]')
    .description(
      'Check Skill sources for updates (contacts remotes; never approves/installs)',
    )
    .option('--json', 'emit structured JSON only')
    .action(
      async (selector: string | undefined, options: { json?: boolean }) => {
        const result = await dependencies.skillCheck(
          selector ? { selector } : {},
        );
        dependencies.writeOut(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : renderCheck(result),
        );
      },
    );
};

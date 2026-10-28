/**
 * Output for cross-agent Project Memory (spec 2026-10-28 §7–§8): the notes a
 * Memory command prints after it refreshes the agent files, `stak memory
 * agents`, and the one-line-per-agent status in `stak status` / `stak memory
 * status`. Terse, and silent when there is nothing to say.
 */
import { AGENT_EXPORT_RELATIVE_PATHS } from '@stack/memory';

import type {
  AgentDisableReport,
  AgentExportAgentReport,
  AgentExportId,
  AgentExportProjectNote,
  AgentExportReport,
  AgentMemoryAgentStatus,
  AgentMemoryStatusReport,
  AgentResetReport,
} from '../memory/agent-export-ops.js';
import { agentLabel, block } from './format.js';

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

const names = (items: ReadonlyArray<{ name: string }>): string =>
  items.map((item) => item.name).join(', ');

/** One note per kind of skip, naming the projects. */
const skipNotes = (
  agent: AgentExportId,
  skipped: AgentExportProjectNote[],
): string[] => {
  const label = agentLabel(agent);
  const file = AGENT_EXPORT_RELATIVE_PATHS[agent];
  const of = (status: AgentExportProjectNote['status']) =>
    skipped.filter((s) => s.status === status);
  const grouped = (
    status: AgentExportProjectNote['status'],
    reason: string,
  ): string[] => {
    const items = of(status);
    return items.length === 0
      ? []
      : [
          `${label}: ${plural(items.length, 'project')} skipped — ${reason} (${names(items)}).`,
        ];
  };
  const handEdited = of('skipped-hand-edited');
  return [
    ...grouped(
      'skipped-not-ignorable',
      `.gitignore re-includes ${file}, so STAK won't write it`,
    ),
    ...(handEdited.length > 0
      ? [
          `${label}: ${file} was edited by hand in ${names(handEdited)}; not overwritten. Move the edit into your memory, or run \`stak memory agents reset ${agent}\`.`,
        ]
      : []),
    ...grouped(
      'skipped-user-file',
      `${file} already exists and wasn't written by STAK`,
    ),
    ...grouped('skipped-tracked', `${file} is tracked by Git`),
    ...grouped(
      'skipped-no-git',
      `Git isn't available, so STAK can't keep ${file} out of the repository`,
    ),
    ...grouped(
      'skipped-team-too-large',
      'the team AGENTS.md alone is too large for Codex to also read STAK Memory',
    ),
    ...of('skipped-ambiguous').map(
      (s) => `${label}: ${s.name} skipped — ${s.message ?? 'not located'}.`,
    ),
    ...of('failed').map(
      (s) =>
        `${label}: couldn't write ${file} for ${s.name}${s.message ? `: ${s.message}` : ''}`,
    ),
  ];
};

const agentNotes = (
  report: AgentExportAgentReport,
  mode: 'refresh' | 'enable' | 'reset',
): string[] => {
  const label = agentLabel(report.agent);
  const shared = report.written + report.unchanged;
  const lines: string[] = [];
  if (mode === 'enable')
    lines.push(
      shared > 0
        ? `${label}: memory shared with ${plural(shared, 'project')}.`
        : report.skipped.length > 0
          ? `${label}: memory sharing is on.`
          : `${label}: memory sharing is on. No project with Memory was found on this machine yet.`,
    );
  else if (mode === 'reset')
    lines.push(
      report.written > 0
        ? `${label}: rewrote ${AGENT_EXPORT_RELATIVE_PATHS[report.agent]} in ${plural(report.written, 'project')}.`
        : `${label}: nothing to reset.`,
    );
  else if (report.written > 0)
    lines.push(
      `${label}: memory updated for ${plural(report.written, 'project')}.`,
    );
  lines.push(...skipNotes(report.agent, report.skipped));
  const omitted = report.overBudget.reduce(
    (sum, p) => sum + p.omitted.length,
    0,
  );
  if (omitted > 0)
    lines.push(
      `${label}: ${plural(omitted, 'note')} left out to save space (${names(report.overBudget)}).`,
    );
  return lines;
};

/** The notes an exporting command prints. Empty when there is nothing to say. */
export const agentExportNotes = (
  report: AgentExportReport | undefined,
  mode: 'refresh' | 'enable' | 'reset' = 'refresh',
): string[] =>
  report
    ? [
        ...report.agents.flatMap((agent) => agentNotes(agent, mode)),
        ...report.problems.map((problem) => problem.message),
      ]
    : [];

/** `agentExportNotes` as a printable block, or '' when there is nothing. */
export const renderAgentExportNotes = (
  report: AgentExportReport | undefined,
  mode: 'refresh' | 'enable' | 'reset' = 'refresh',
): string => {
  const lines = agentExportNotes(report, mode);
  return lines.length > 0 ? block(lines) : '';
};

export const renderAgentReset = (
  agent: AgentExportId,
  report: AgentResetReport,
): string => {
  if (!report.enabled && report.problems.length === 0)
    return block([
      `${agentLabel(agent)} memory sharing is off. Turn it on with \`stak memory agents enable ${agent}\`.`,
    ]);
  return block([
    ...(report.agents.length === 0 && report.problems.length === 0
      ? [`${agentLabel(agent)}: nothing to reset.`]
      : []),
    ...agentExportNotes(report, 'reset'),
  ]);
};

export const renderAgentDisable = (report: AgentDisableReport): string => {
  const label = agentLabel(report.agent);
  const file = AGENT_EXPORT_RELATIVE_PATHS[report.agent];
  const lines = [
    report.removed > 0
      ? `${label}: memory sharing is off. Removed ${file} from ${plural(report.removed, 'project')}.`
      : `${label}: memory sharing is off.`,
  ];
  if (report.kept.length > 0)
    lines.push(
      `${label}: kept ${file} in ${names(report.kept)} (or its old folder) because it was edited by hand. It is still excluded from Git, so it can't be committed by accident. Delete it when you no longer need it.`,
    );
  for (const failure of report.failed)
    lines.push(
      `${label}: couldn't remove ${file} for ${failure.name}: ${failure.message}`,
    );
  lines.push(...report.problems.map((problem) => problem.message));
  return block(lines);
};

/** The short summary of one enabled agent's files. */
const statusSummary = (status: AgentMemoryAgentStatus): string => {
  const parts = [
    status.outOfDate > 0 && `${status.outOfDate} out of date`,
    status.skipped > 0 && `${status.skipped} skipped`,
    status.handEdited > 0 && `${status.handEdited} hand-edited`,
    status.notIgnorable > 0 && `${status.notIgnorable} not ignorable`,
    status.overBudget > 0 && `${status.overBudget} over budget`,
  ].filter((part): part is string => typeof part === 'string');
  if (status.projects === 0) return 'on, no projects with Memory yet';
  if (parts.length === 0)
    return `up to date (${plural(status.projects, 'project')})`;
  return `${parts.join(', ')} of ${plural(status.projects, 'project')}`;
};

/** `stak status` / `stak memory status`: one line per ENABLED agent, under an
 * "Agent memory" heading. Empty when no agent is on. */
export const agentMemoryStatusLines = (
  report: AgentMemoryStatusReport | undefined,
): string[] => {
  if (!report) return [];
  const enabled = report.agents.filter((agent) => agent.enabled);
  if (enabled.length === 0 && report.problems.length === 0) return [];
  const needsDetail = enabled.some((s) => s.details.length > 0);
  return [
    '',
    'Agent memory',
    ...enabled.map(
      (status) =>
        `  ${agentLabel(status.agent).padEnd(9)}${statusSummary(status)}`,
    ),
    ...report.problems.map((problem) => `  ${problem.message}`),
    ...(needsDetail ? ['  Details: `stak memory agents`'] : []),
  ];
};

/** `stak memory agents`: every agent on/off, the short status, and what to do
 * for each project that needs it. */
export const renderAgentMemoryList = (
  report: AgentMemoryStatusReport,
): string => {
  const lines: string[] = [];
  for (const status of report.agents) {
    lines.push(
      `${agentLabel(status.agent).padEnd(9)}${
        status.enabled ? `on    ${statusSummary(status)}` : 'off'
      }`,
    );
    for (const detail of status.details) {
      const parts = [
        detail.message,
        detail.omitted?.length
          ? `${plural(detail.omitted.length, 'note')} left out to save space: ${detail.omitted.join(', ')}`
          : undefined,
      ].filter((part): part is string => part !== undefined);
      lines.push(`  ${detail.name}: ${parts.join('; ')}`);
    }
  }
  lines.push(...report.problems.map((problem) => problem.message));
  if (report.agents.every((status) => !status.enabled))
    lines.push(
      '',
      'Share your project Memory with an agent: `stak memory agents enable <codex|cursor>` (or `stak run codex|cursor`).',
    );
  else if (report.agents.some((status) => status.outOfDate > 0))
    lines.push(
      '',
      'Refresh out-of-date files: `stak memory agents enable <agent>`.',
    );
  return block(lines);
};

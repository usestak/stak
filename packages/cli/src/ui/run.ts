import type { BindingPlan } from '@stack/spec';

import { agentLabel, block, skills } from './format.js';

const label: Record<BindingPlan['operations'][number]['state'], string> = {
  'already-managed': 'Already managed',
  'externally-satisfied': 'Already available',
  add: 'Add',
  'update-managed': 'Update managed',
  'managed-drift': 'Managed drift',
  'remove-managed': 'Remove managed',
  'conflict-unmanaged': 'Unmanaged conflict',
  'conflict-name': 'Name conflict',
  'invalid-target-name': 'Invalid name',
  'store-unavailable': 'Store missing',
  'store-corrupt': 'Store corrupt',
  'visibility-conflict': 'Visibility conflict',
};

export type BindingSummary = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
  mutating: boolean;
  firstSetup: boolean;
};

const count = (plan: BindingPlan, ...states: string[]): number =>
  plan.operations.filter((operation) => states.includes(operation.state))
    .length;

/** Beginner-facing rollup of a binding plan. */
export const summarizeBinding = (plan: BindingPlan): BindingSummary => {
  const added = count(plan, 'add');
  const updated = count(plan, 'update-managed', 'managed-drift');
  const removed = count(plan, 'remove-managed');
  const unchanged = count(plan, 'already-managed', 'externally-satisfied');
  const mutating = added + updated + removed > 0;
  return {
    added,
    updated,
    removed,
    unchanged,
    total: added + updated + unchanged,
    mutating,
    firstSetup: unchanged === 0 && updated === 0 && removed === 0,
  };
};

/** Count lines like "2 skills added" / "1 skill updated" (no trailing period). */
export const bindingCountLines = (summary: BindingSummary): string[] =>
  [
    summary.added > 0 && `${skills(summary.added)} added`,
    summary.updated > 0 && `${skills(summary.updated)} updated`,
    summary.removed > 0 && `${skills(summary.removed)} removed`,
  ].filter((line): line is string => Boolean(line));

/** Human dry-run preview for `stak run <agent> --dry-run`. */
export const renderRunDryRun = (plan: BindingPlan): string => {
  const agent = agentLabel(plan.agent);
  const summary = summarizeBinding(plan);
  if (!summary.mutating)
    return block([
      `${agent} is already set up with ${skills(summary.total)}.`,
      '',
      'No changes were made.',
    ]);
  if (summary.firstSetup)
    return block([
      `${agent} will be set up with ${skills(summary.added)}.`,
      '',
      'No changes were made.',
    ]);
  return block([
    `${agent} will be updated.`,
    '',
    ...bindingCountLines(summary),
    '',
    'No changes were made.',
  ]);
};

/** Detailed plan retained for `--verbose`. */
export const renderBindingPlan = (
  plan: BindingPlan,
  dryRun: boolean,
): string => {
  const counts = new Map<string, number>();
  for (const operation of plan.operations)
    counts.set(operation.state, (counts.get(operation.state) ?? 0) + 1);
  const lines = [
    `Environment: ${plan.environment}`,
    `Agent: ${agentLabel(plan.agent)}`,
    '',
    `Binding root: ${plan.targetRoot}`,
    '',
    ...[...counts].map(
      ([state, value]) => `${label[state as keyof typeof label]}      ${value}`,
    ),
  ];
  for (const operation of plan.operations.filter(
    (item) =>
      item.state.startsWith('conflict') ||
      item.state.startsWith('store-') ||
      item.state === 'invalid-target-name',
  ))
    lines.push(
      '',
      `${label[operation.state]}: ${operation.skillName}`,
      operation.targetPath,
    );
  lines.push(
    '',
    dryRun
      ? 'Dry run. No changes were made.'
      : plan.blocking
        ? 'Conflicts must be resolved before launch.'
        : '',
  );
  return `${lines.filter((line, index, all) => line || all[index - 1] !== '').join('\n')}\n`;
};

import type { BindingPlan } from '@stack/spec';

const label: Record<BindingPlan['operations'][number]['state'], string> = {
  'already-managed': 'Already managed',
  'externally-satisfied': 'Already available',
  add: 'Add',
  'update-managed': 'Update managed',
  'managed-drift': 'Managed drift',
  'conflict-unmanaged': 'Unmanaged conflict',
  'conflict-name': 'Name conflict',
  'invalid-target-name': 'Invalid name',
  'store-unavailable': 'Store missing',
  'store-corrupt': 'Store corrupt',
};

export const renderBindingPlan = (
  plan: BindingPlan,
  dryRun: boolean,
): string => {
  const counts = new Map<string, number>();
  for (const operation of plan.operations)
    counts.set(operation.state, (counts.get(operation.state) ?? 0) + 1);
  const lines = [
    `Environment: ${plan.environment}`,
    'Agent: Codex',
    '',
    `Binding root: ${plan.targetRoot}`,
    '',
    ...[...counts].map(
      ([state, count]) => `${label[state as keyof typeof label]}      ${count}`,
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

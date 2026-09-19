import type { InitializeMainEnvironmentResult } from '@stack/core';
import type {
  EnvironmentDiff,
  EnvironmentStatus,
  SkillStatus,
} from '@stack/spec';

export const renderInitResult = (
  result: InitializeMainEnvironmentResult,
): string => {
  const lines = [
    'Creating main...',
    '',
    `${result.importedSkills} valid global Skills imported`,
    `${result.excludedInvalid} invalid Skills excluded`,
    `${result.excludedProject} project Skills excluded`,
    '',
    `Physical locations recorded      ${result.physicalLocations}`,
    `Exact duplicates consolidated    ${result.consolidatedDuplicates}`,
    `Name collisions preserved        ${result.nameCollisions}`,
    '',
    'Preservation',
    '',
    `${result.preservedContents} Skill contents preserved locally`,
    `${result.references} portable Git references`,
    `${result.snapshots} local snapshots`,
    `${result.integrityChecks}/${result.importedSkills} integrity checks passed`,
  ];
  lines.push(
    '',
    'main created.',
    '',
    'No source Skill files were modified.',
    '',
  );
  return lines.join('\n');
};

const skillLines = (title: string, marker: string, skills: SkillStatus[]) => {
  const matching = skills.filter(
    (skill) => skill.state === title.toLowerCase(),
  );
  return matching.length === 0
    ? []
    : ['', title, ...matching.map((skill) => `${marker} ${skill.name}`)];
};

export const renderStatus = (status: EnvironmentStatus): string => {
  const summary = status.summary;
  const lines = [
    `Environment: ${status.environment}`,
    '',
    `Direct Skills    ${status.skills.filter((skill) => skill.origins?.some((origin) => origin.type === 'direct')).length}`,
    `Stack layers     ${status.stacks?.length ?? 0}`,
    `Resolved Skills  ${status.desiredCount}`,
    '',
    `Satisfied      ${summary.satisfied}`,
    `Modified       ${summary.modified}`,
    `Missing        ${summary.missing}`,
    `Uncertain      ${summary.uncertain}`,
    `Untracked      ${summary.untracked}`,
    '',
    'Placement drift',
    `${summary.placementAdded} added placement`,
    `${summary.placementRemoved} removed placement`,
    `${summary.placementChanged} changed placement`,
    '',
    'Local preservation',
    '',
    `Available      ${summary.preservation.available}`,
    `Missing        ${summary.preservation.missing}`,
    `Corrupt        ${summary.preservation.corrupt}`,
    '',
    'Restoration strategy',
    '',
    `Reference      ${summary.restoration.reference}`,
    `Snapshot       ${summary.restoration.snapshot}`,
  ];
  if (status.stacks?.length)
    lines.splice(
      5,
      0,
      '',
      'Stacks',
      ...status.stacks.map((stack) => `✓ ${stack.name}`),
    );
  if (summary.rootFailures > 0)
    lines.push(
      '',
      'Warnings',
      `${summary.rootFailures} root could not be scanned`,
    );
  lines.push(
    ...skillLines('Modified', '~', status.skills),
    ...skillLines('Missing', '-', status.skills),
    ...skillLines('Uncertain', '?', status.skills),
  );
  if (status.untracked.length > 0)
    lines.push(
      '',
      'Untracked',
      ...status.untracked.map((skill) => `+ ${skill.name}`),
    );
  if (status.invalidSkills.length > 0)
    lines.push(
      '',
      'Invalid discovered Skills',
      `${status.invalidSkills.length}`,
    );
  lines.push('', 'No changes were made.', '');
  return lines.join('\n');
};

const sourceLabel = (source: SkillStatus['desiredSource']): string => {
  if (!source) return 'ambiguous or unavailable';
  if (source.type === 'git')
    return `${source.remote ?? 'local git repository'} @ ${source.revision} (${source.path})`;
  return source.type;
};

export const renderDiff = (diff: EnvironmentDiff): string => {
  const lines = [`Environment diff: ${diff.environment}`];
  for (const entry of diff.entries.filter(
    (item) =>
      item.state !== 'satisfied' || item.preservation.state !== 'available',
  )) {
    lines.push(
      '',
      entry.name,
      '',
      'State',
      entry.state.toUpperCase(),
      '',
      'Environment entry',
      entry.entryId,
      '',
      'Desired',
      entry.desiredHash,
      '',
      'Local preservation',
      entry.preservation.state.toUpperCase(),
    );
    if (entry.preservation.message) lines.push(entry.preservation.message);
    if (entry.currentHash) lines.push('', 'Current', entry.currentHash);
    if (entry.origins?.length)
      lines.push(
        '',
        'Required by',
        ...entry.origins.map((origin) =>
          origin.type === 'direct'
            ? `Direct: ${origin.entryId}`
            : `Stack: ${origin.stackName}`,
        ),
      );
    lines.push('', 'Desired source', sourceLabel(entry.desiredSource));
    if (entry.currentSource)
      lines.push('', 'Current source', sourceLabel(entry.currentSource));
    if (entry.baselineLocations.length > 0)
      lines.push(
        '',
        'Baseline locations',
        ...entry.baselineLocations.map(
          (item) => `${item.rootKind}/${item.scope}  ${item.path}`,
        ),
      );
    if (entry.currentLocations.length > 0)
      lines.push(
        '',
        'Current locations',
        ...entry.currentLocations.map(
          (item) => `${item.rootKind}/${item.scope}  ${item.path}`,
        ),
      );
  }
  if (diff.untracked.length > 0)
    lines.push(
      '',
      'Untracked',
      ...diff.untracked.map((item) => `+ ${item.name}  ${item.contentHash}`),
    );
  if (diff.placementDrift.length > 0)
    lines.push(
      '',
      'Placement drift',
      ...diff.placementDrift.map(
        (item) =>
          `${item.kind.toUpperCase()} ${item.name}  ${item.rootKind}/${item.scope}  ${item.path}`,
      ),
    );
  if (diff.rootFailures.length > 0)
    lines.push(
      '',
      'Incomplete observation',
      ...diff.rootFailures.map(
        (root) => `${root.path}: ${root.error ?? 'scan failed'}`,
      ),
    );
  if (
    diff.entries.every((item) => item.state === 'satisfied') &&
    diff.entries.every((item) => item.preservation.state === 'available') &&
    diff.untracked.length === 0 &&
    diff.placementDrift.length === 0
  )
    lines.push('', 'No drift detected.');
  lines.push('', 'No changes were made.', '');
  return lines.join('\n');
};

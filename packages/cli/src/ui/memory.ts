import type {
  BackupComposition,
  BackupResult,
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
} from '@stack/memory';
import { countProjects, projectIdentityKey } from '@stack/memory';

import type {
  CloudRecoverOutcome,
  MemoryBackupOutcome,
  MemoryCloudStatus,
} from '../memory/cloud-ops.js';
import { block } from './format.js';

type RenderOptions = { verbose?: boolean };

const files = (count: number) =>
  `${count} memory file${count === 1 ? '' : 's'}`;
const plainFiles = (count: number) => `${count} file${count === 1 ? '' : 's'}`;
const projects = (count: number) => `${count} project${count === 1 ? '' : 's'}`;

const relativeTime = (iso: string, nowMs = Date.now()): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  for (const [unit, name] of [
    [day, 'day'],
    [hour, 'hour'],
    [minute, 'minute'],
  ] as const)
    if (seconds >= unit) {
      const value = Math.floor(seconds / unit);
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  return 'just now';
};

const distinctProjects = (items: DiscoveredMemoryItem[]): number =>
  new Set(
    items.flatMap((item) =>
      item.scope === 'project' && item.project
        ? [projectIdentityKey(item.project)]
        : [],
    ),
  ).size;

export const renderMemoryScan = (
  items: DiscoveredMemoryItem[],
  options: RenderOptions = {},
): string => {
  if (items.length === 0)
    return block([
      'Claude',
      '',
      'No memory found.',
      '',
      'Nothing was changed.',
    ]);
  const lines = [
    'Claude',
    '',
    `${projects(distinctProjects(items))} with memory`,
    `${files(items.length)} found`,
  ];
  if (options.verbose) {
    lines.push('', 'Items');
    for (const item of items)
      lines.push(
        `${item.kind}  ${item.scope}  ${item.logicalId}  ${item.contentHash.slice(0, 15)}…`,
      );
  }
  lines.push('', 'Nothing was changed.');
  return block(lines);
};

export const renderMemoryBackup = (result: BackupResult): string =>
  block([
    `${files(result.files)} saved.`,
    `${projects(result.projects)} backed up.`,
  ]);

/** Local-first backup with the Cloud outcome (Standard/Protected/skipped/failed). */
export const renderMemoryCloudBackup = (
  outcome: MemoryBackupOutcome,
): string => {
  const { local, cloud } = outcome;
  const head = [`${files(local.files)} saved locally.`, ''];
  if (cloud.status === 'skipped')
    return block([
      ...head,
      'Cloud backup skipped.',
      'Run `stack login` to protect this backup from machine loss.',
    ]);
  if (cloud.status === 'protected-locked')
    return block([
      ...head,
      "Protected Cloud backup couldn't be created because this device",
      'cannot unlock your protected Memory.',
      '',
      'Run:',
      '  stack memory recover',
    ]);
  if (cloud.status === 'failed')
    return block([
      ...head,
      'Cloud backup failed.',
      'Your local backup is safe.',
      '',
      cloud.message,
    ]);
  if (cloud.status === 'protected')
    return block([
      ...head,
      `${projects(local.projects)} backed up to Stack Cloud.`,
      '',
      'Privacy: Protected',
    ]);
  return block([
    ...head,
    `${projects(local.projects)} backed up to Stack Cloud.`,
    '',
    'Privacy: Standard',
    '',
    'For client-side encryption:',
    '  stack memory protect',
  ]);
};

/** Cloud → local private store recovery (does not touch native agent files). */
export const renderMemoryRecover = (outcome: CloudRecoverOutcome): string => {
  if (outcome.status === 'not-authenticated')
    return block(['Not signed in.', 'Run `stack login` first.']);
  if (outcome.status === 'no-backup')
    return block(['No Cloud backup found for this account.']);
  if (outcome.status === 'needs-recovery-method')
    return block([
      'Protected Memory found.',
      '',
      'This device can’t unlock it yet.',
      'Recover with a passkey in your browser, or use a recovery file:',
      '  stack memory recover --recovery-file <path>',
    ]);
  return block([
    'Memory recovered.',
    '',
    `${plainFiles(outcome.objects)} available`,
    `Privacy: ${outcome.privacyMode === 'protected' ? 'Protected' : 'Standard'}`,
    '',
    'Run `stack memory restore`.',
  ]);
};

export const renderMemoryProtect = (result: {
  recoveryMethod: 'passkey' | 'recovery-file';
  migrated: number;
  recoveryFilePath?: string;
}): string => {
  const isFile = result.recoveryMethod === 'recovery-file';
  const lines: Array<string | false> = [
    'Protected backup enabled.',
    '',
    'Recovery',
  ];
  if (isFile) {
    lines.push('Recovery file    Ready');
    if (result.recoveryFilePath)
      lines.push(`Saved to ${result.recoveryFilePath}`);
    // The recovery-file warning is shown ONLY for the recovery-file method.
    lines.push(
      '',
      'Keep this file safe — anyone with it can recover your Memory.',
    );
  } else {
    lines.push('Passkey    Ready', '');
  }
  if (result.migrated > 0)
    lines.push(`${plainFiles(result.migrated)} migrated to Protected.`);
  lines.push(
    '',
    'Add another recovery method so losing one credential',
    'doesn’t lose your Memory.',
  );
  return block(lines);
};

/** Cloud state appended to the local status view. */
export const renderMemoryCloudStatus = (
  local: MemoryStatus | null,
  cloud: MemoryCloudStatus,
): string => {
  const lines = [
    'Claude',
    '',
    `${projects(local?.projects ?? 0)} backed up`,
    `${files(local?.files ?? 0)}`,
  ];
  if (!cloud.authenticated) {
    lines.push('', 'Cloud             not signed in');
    return block(lines);
  }
  lines.push(
    '',
    `Cloud             ${cloud.latestGeneration === null ? 'no backup yet' : 'up to date'}`,
    `Privacy           ${cloud.privacyMode === 'protected' ? 'Protected' : 'Standard'}`,
  );
  if (cloud.recoveryMethodTypes.length > 0)
    lines.push(
      `Recovery          ${cloud.recoveryMethodTypes
        .map((type) => (type === 'recovery-file' ? 'Recovery file' : 'Passkey'))
        .join(', ')}`,
    );
  return block(lines);
};

export const renderMemoryStatus = (
  status: MemoryStatus | null,
  options: RenderOptions = {},
): string => {
  if (!status)
    return block([
      'Claude',
      '',
      'No backup yet.',
      'Run `stack memory backup` to protect your memory.',
    ]);
  const lines = [
    'Claude',
    '',
    `${projects(status.projects)} protected`,
    status.lastBackupAt
      ? `Last backup ${relativeTime(status.lastBackupAt)}`
      : 'No backup yet',
  ];
  if (options.verbose) lines.push('', `${files(status.files)} stored`);
  return block(lines);
};

export const renderMemoryRestore = (
  plan: RestorePlan,
  options: { dryRun: boolean; verbose?: boolean },
): string => {
  const restorable = plan.items.filter((item) => item.status === 'restorable');
  const restored = plan.items.filter((item) => item.status === 'restored');
  const conflicts = plan.items.filter((item) => item.status === 'conflict');
  const notFound = plan.items.filter(
    (item) => item.status === 'project-not-found',
  );
  const identityConflicts = plan.items.filter(
    (item) => item.status === 'identity-conflict',
  );
  const identical = plan.items.filter((item) => item.status === 'identical');

  // Counts are unique project identities, never one-per-file.
  const projectsInBackup = plan.projects;
  const unavailableProjects = countProjects(notFound);
  const conflictedProjects = countProjects(identityConflicts);

  if (options.dryRun) {
    const lines = [
      'Memory restore preview',
      '',
      'Claude',
      '',
      `${projects(projectsInBackup)} in backup`,
      files(plan.files),
      '',
      `${plainFiles(restorable.length)} ready to restore`,
    ];
    if (identical.length > 0)
      lines.push(`${plainFiles(identical.length)} already up to date`);
    if (conflicts.length > 0)
      lines.push(
        `${plainFiles(conflicts.length)} would conflict and be left unchanged`,
      );
    if (notFound.length > 0)
      lines.push(
        `${plainFiles(notFound.length)} retained from ${projects(unavailableProjects)} not available on this machine`,
      );
    if (identityConflicts.length > 0)
      lines.push(
        `${plainFiles(identityConflicts.length)} from ${projects(conflictedProjects)} need explicit mapping (identity conflict)`,
      );
    lines.push('', 'Existing agent memory will not be overwritten.', '');
    if (notFound.length > 0 || identityConflicts.length > 0)
      lines.push('Run `stack project` to review them.');
    if (options.verbose)
      for (const item of plan.items)
        lines.push(`${item.status}  ${item.logicalId}`);
    lines.push('No changes were made.');
    return block(lines);
  }

  const lines = [`${plainFiles(restored.length)} restored.`];
  if (identical.length > 0)
    lines.push(`${plainFiles(identical.length)} already up to date.`);
  if (conflicts.length > 0)
    lines.push(`${plainFiles(conflicts.length)} left unchanged (conflict).`);
  if (notFound.length > 0)
    lines.push(
      `${plainFiles(notFound.length)} retained from ${projects(unavailableProjects)} not available on this machine.`,
    );
  if (identityConflicts.length > 0)
    lines.push(
      `${plainFiles(identityConflicts.length)} from ${projects(conflictedProjects)} need explicit mapping (identity conflict).`,
    );
  if (notFound.length > 0 || identityConflicts.length > 0)
    lines.push('Run `stack project` to review them.');
  return block(lines);
};

export type MemoryBackupPreview = BackupComposition & {
  privacy: 'standard' | 'protected' | null;
};

const privacyLabel = (privacy: MemoryBackupPreview['privacy']): string =>
  privacy === 'protected'
    ? 'Protected'
    : privacy === 'standard'
      ? 'Standard'
      : 'local backup only (sign in to back up to Cloud)';

/** Non-mutating preview of the next backup's composition (`--dry-run`). */
export const renderMemoryBackupPreview = (
  preview: MemoryBackupPreview,
  options: RenderOptions = {},
): string => {
  const lines = [
    'Memory backup preview',
    '',
    'Claude',
    '',
    `${projects(preview.nativeProjects)} available on this machine`,
    `${files(preview.nativeFiles)} to capture`,
  ];
  if (preview.retainedFiles > 0)
    lines.push(
      `${projects(preview.retainedProjects)} not available on this machine`,
      `${files(preview.retainedFiles)} carried forward unchanged`,
    );
  lines.push(
    '',
    'Next backup',
    `${projects(preview.finalProjects)}`,
    files(preview.finalFiles),
    `Privacy: ${privacyLabel(preview.privacy)}`,
  );
  if (options.verbose) {
    lines.push('', 'Carried forward:');
    if (preview.carriedForward.length === 0) lines.push('  (none)');
    for (const item of preview.carriedForward)
      lines.push(`  retained  ${item.logicalId}`);
  }
  lines.push('', 'No changes were made.');
  return block(lines);
};

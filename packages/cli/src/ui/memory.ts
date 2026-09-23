import type {
  BackupResult,
  DiscoveredMemoryItem,
  MemoryStatus,
  RestorePlan,
} from '@stack/memory';
import { projectIdentityKey } from '@stack/memory';

import { block } from './format.js';

type RenderOptions = { verbose?: boolean };

const files = (count: number) =>
  `${count} memory file${count === 1 ? '' : 's'}`;
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
    `${projects(result.projects)} protected.`,
  ]);

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
  const identical = plan.items.filter((item) => item.status === 'identical');

  if (options.dryRun) {
    const lines = [
      'Memory restore preview',
      '',
      'Claude',
      `${plan.projects} projects`,
      `${files(restorable.length + identical.length + conflicts.length + notFound.length)}`,
    ];
    if (conflicts.length > 0)
      lines.push(
        '',
        `${conflicts.length} would conflict and be left unchanged.`,
      );
    if (notFound.length > 0)
      lines.push(`${notFound.length} for projects not on this machine.`);
    lines.push('', 'Existing agent memory will not be overwritten.', '');
    if (options.verbose)
      for (const item of plan.items)
        lines.push(`${item.status}  ${item.logicalId}`);
    lines.push('No changes were made.');
    return block(lines);
  }

  const lines = [`${files(restored.length)} restored.`];
  if (identical.length > 0) lines.push(`${identical.length} already present.`);
  if (conflicts.length > 0)
    lines.push(`${conflicts.length} left unchanged (conflict).`);
  if (notFound.length > 0)
    lines.push(
      `${notFound.length} skipped (project not found on this machine).`,
    );
  return block(lines);
};

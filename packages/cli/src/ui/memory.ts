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
  PasskeyFailureReason,
} from '../memory/cloud-ops.js';
import { projectFoldNotes } from './cloud.js';
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
  // Spec §4.2.1: a project merged before syncing is reported once, up front.
  const folded =
    'folded' in cloud
      ? projectFoldNotes(cloud.folded).map((note) => `${note}.`)
      : [];
  const head = [`${files(local.files)} saved locally.`, ...folded, ''];
  if (cloud.status === 'skipped')
    return block([
      ...head,
      'Cloud backup skipped.',
      'Run `stak login` to protect this backup from machine loss.',
    ]);
  if (cloud.status === 'nothing-staged')
    return block([
      ...head,
      'Nothing to back up to STAK Cloud yet.',
      'Run `stak add .` to stage Memory, then back up again.',
    ]);
  if (cloud.status === 'up-to-date')
    return block([
      ...head,
      `Already up to date with STAK Cloud (generation ${cloud.generation}).`,
    ]);
  if (cloud.status === 'conflict')
    return block([
      ...head,
      `Memory has ${cloud.conflicts.length} unresolved conflict(s) with STAK Cloud.`,
      '',
      'Run:',
      '  stak memory resolve <project> <path> --keep local|cloud|both',
      '  stak memory backup',
    ]);
  if (cloud.status === 'protected-locked')
    return block([
      ...head,
      "Protected Cloud backup couldn't be created because this device",
      'cannot unlock your protected Memory.',
      '',
      'Run:',
      '  stak memory recover',
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
      `${projects(local.projects)} backed up to STAK Cloud.`,
      '',
      'Privacy: Protected',
    ]);
  return block([
    ...head,
    `${projects(local.projects)} backed up to STAK Cloud.`,
    '',
    'Privacy: Standard',
    '',
    'For client-side encryption:',
    '  stak memory protect',
  ]);
};

/** Cloud → local private store recovery (does not touch native agent files). */
export const renderMemoryRecover = (outcome: CloudRecoverOutcome): string => {
  if (outcome.status === 'not-authenticated')
    return block(['Not signed in.', 'Run `stak login` first.']);
  if (outcome.status === 'no-backup')
    return block(['No Cloud backup found for this account.']);
  if (outcome.status === 'needs-recovery-method')
    return block([
      'Protected Memory found.',
      '',
      'This device can’t unlock it yet.',
      'Recover with a passkey in your browser, or use a recovery file:',
      '  stak memory recover --recovery-file <path>',
    ]);
  // Project Memory (canonical documents) is written into agent files by the next
  // `stak pull`, or by `stak memory materialize` — never by `stak memory restore`.
  // Legacy/global v1 items are the only thing `stak memory restore` still writes
  // (global, e.g. `~/.claude/CLAUDE.md`-type Memory). Only mention each hint when
  // that kind of item was actually recovered.
  const hasProjectFiles = outcome.projectFiles > 0;
  const hasLegacyFiles = outcome.legacyFiles > 0;
  const hints: string[] = [];
  if (hasProjectFiles)
    hints.push(
      'Run `stak pull` to write it into your projects (or `stak memory materialize`).',
    );
  if (hasLegacyFiles) hints.push('Run `stak memory restore`.');
  return block([
    `Memory recovered from backup #${outcome.generation}.`,
    '',
    `${plainFiles(outcome.files)} available`,
    `Privacy: ${outcome.privacyMode === 'protected' ? 'Protected' : 'Standard'}`,
    // Spec §4.2.1 (review fix M3): a project merged by the recover, once.
    ...projectFoldNotes(outcome.folded).map((note) => `${note}.`),
    ...(hints.length > 0 ? ['', ...hints] : []),
  ]);
};

/**
 * A bounded, non-alarming terminal message when a passkey ceremony does not complete
 * (Phase R6). Never claims Memory is corrupted and never implies a silent Standard
 * fallback; for recovery it always surfaces the existing recovery-file option.
 */
export const renderPasskeyFailure = (
  mode: 'protect' | 'recover',
  reason: PasskeyFailureReason,
): string => {
  const recoverFallback = [
    'You can retry the passkey, or use your recovery file:',
    '  stak memory recover --recovery-file <path>',
  ];
  const protectFallback = [
    'You can retry the passkey, or set up a recovery file instead:',
    '  stak memory protect --recovery-file <path>',
  ];
  const fallback = mode === 'recover' ? recoverFallback : protectFallback;
  const headline =
    reason === 'cancelled'
      ? 'Passkey request cancelled.'
      : reason === 'unsupported'
        ? 'This device can’t use a passkey for Protected Memory.'
        : reason === 'timed-out'
          ? 'Timed out waiting for the browser passkey.'
          : reason === 'session-expired'
            ? 'The browser session expired before it finished.'
            : 'STAK couldn’t complete the passkey request.';
  // Unsupported authenticators cannot retry into success — lead with the fallback.
  const body =
    reason === 'unsupported' && mode === 'recover'
      ? [
          'Use your recovery file:',
          '  stak memory recover --recovery-file <path>',
        ]
      : reason === 'unsupported' && mode === 'protect'
        ? [
            'Protect with a recovery file instead:',
            '  stak memory protect --recovery-file <path>',
          ]
        : fallback;
  return block([headline, '', ...body]);
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
  // Phase 15B.6: when the local store came from an OLDER generation than the Cloud
  // latest, do NOT claim "up to date" — show the historical-recovery relationship.
  if (cloud.historicalRecovery) {
    lines.push(
      '',
      `Local source      Backup #${cloud.localRecoveredGeneration}`,
      `Cloud latest      Backup #${cloud.latestGeneration}`,
      `Privacy           ${cloud.privacyMode === 'protected' ? 'Protected' : 'Standard'}`,
    );
  } else {
    lines.push(
      '',
      `Cloud             ${cloud.latestGeneration === null ? 'no backup yet' : 'up to date'}`,
      `Privacy           ${cloud.privacyMode === 'protected' ? 'Protected' : 'Standard'}`,
    );
  }
  if (cloud.recoveryMethodTypes.length > 0)
    lines.push(
      `Recovery          ${cloud.recoveryMethodTypes
        .map((type) => (type === 'recovery-file' ? 'Recovery file' : 'Passkey'))
        .join(', ')}`,
    );
  if (cloud.historicalRecovery)
    lines.push(
      '',
      'Historical recovery',
      `Local Memory was recovered from backup #${cloud.localRecoveredGeneration}.`,
      `Backup #${cloud.latestGeneration} remains your latest Cloud backup.`,
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
      'Run `stak memory backup` to protect your memory.',
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
      lines.push('Run `stak project` to review them.');
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
    lines.push('Run `stak project` to review them.');
  return block(lines);
};

export type BackupSupersessionView = {
  localRecoveredGeneration: number | null;
  cloudLatestGeneration: number | null;
  parentGeneration: number | null;
  nextGeneration: number | null;
  supersedes: boolean;
  /** Final review T15-4 (see `BackupSupersession.noSyncHistory`). */
  noSyncHistory?: boolean;
};

export type MemoryBackupPreview = BackupComposition & {
  privacy: 'standard' | 'protected' | null;
  supersession: BackupSupersessionView;
  // Fresh/reset-registry safeguard (see `freshRegistryRisksDuplication`): true when
  // this machine has never recovered Cloud Memory, Cloud already has history, and this
  // backup would mint a brand-new Local-only Project identity — i.e. backing up now
  // would risk uploading a second, duplicate logical Project for something Cloud
  // already knows under a different id. Git-backed identities never trigger this.
  // Optional (absent treated as false) so existing preview fixtures stay valid.
  risksDuplicatingLocalProjects?: boolean;
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
  const lines = ['Memory backup preview', '', 'Claude', ''];
  if (preview.risksDuplicatingLocalProjects)
    lines.push(`${freshRegistryGuardWarning()}`, '');
  const s = preview.supersession;
  if (s.supersedes)
    lines.push(
      `Local source      Backup #${s.localRecoveredGeneration}`,
      `Cloud latest      Backup #${s.cloudLatestGeneration}`,
      '',
    );
  // Availability and "native Memory observed" are DISTINCT (Phase 15C.1): a project can
  // be available here yet have no native Memory (e.g. recovered but not yet restored).
  lines.push(
    `${projects(preview.availableProjects)} available on this machine`,
    `${preview.nativeFiles} native memory file${
      preview.nativeFiles === 1 ? '' : 's'
    } found`,
  );
  if (preview.retainedFiles > 0) {
    lines.push(
      '',
      `${preview.retainedFiles} previous memory file${
        preview.retainedFiles === 1 ? '' : 's'
      } preserved`,
    );
    if (preview.retainedAvailableFiles > 0)
      lines.push(
        `  ${plainFiles(preview.retainedAvailableFiles)} from ${projects(preview.retainedAvailableProjects)} available but not currently present in native memory`,
      );
    if (preview.retainedUnavailableFiles > 0)
      lines.push(
        `  ${plainFiles(preview.retainedUnavailableFiles)} from ${projects(preview.retainedUnavailableProjects)} not available on this machine`,
      );
  }
  lines.push(
    '',
    'Next backup',
    `${projects(preview.finalProjects)}`,
    files(preview.finalFiles),
  );
  if (s.nextGeneration !== null)
    lines.push(`Next backup       #${s.nextGeneration}`);
  lines.push(`Privacy: ${privacyLabel(preview.privacy)}`);
  if (s.supersedes)
    lines.push(
      '',
      `This will create backup #${s.nextGeneration} from your current local Memory.`,
      `It will be added after your current latest backup (#${s.cloudLatestGeneration}).`,
      `Backup #${s.cloudLatestGeneration} will remain available in your backup history.`,
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

/** Confirmation prompt shown before a real backup that would supersede a newer backup. */
export const historicalBaseBackupWarning = (
  s: BackupSupersessionView,
): string =>
  `Your local Memory was recovered from backup #${s.localRecoveredGeneration}.\n` +
  `Your latest Cloud backup is #${s.cloudLatestGeneration}.\n\n` +
  `This will create backup #${s.nextGeneration} from your current local Memory.\n` +
  `Backup #${s.cloudLatestGeneration} will remain available in your backup history.`;

/** Refusal shown before a real backup that would risk duplicating Local Projects
 *  Cloud already has history for (the fresh/reset-registry safeguard). */
export const freshRegistryGuardWarning = (): string =>
  'Cloud Memory already exists, but this machine does not have the logical ' +
  'Project identities needed to preserve it.\n' +
  'Run `stak memory recover` before backing up on this machine.';

const bytesLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export type MemoryGenerationRow = {
  generation: number;
  createdAt: string;
  privacyMode: 'standard' | 'protected';
  state: string;
  payloadBytes: number;
  latest: boolean;
};

/** Render the recoverable Memory generation history (no secrets/locators/ids). */
export const renderMemoryGenerations = (
  rows: MemoryGenerationRow[],
  options: { authenticated: boolean } = { authenticated: true },
): string => {
  if (!options.authenticated)
    return 'Not signed in.\nRun `stak login` first.\n';
  if (rows.length === 0)
    return 'No Memory backups yet.\nRun `stak memory backup` first.\n';
  const lines = ['Memory backup history', ''];
  for (const row of [...rows].sort((a, b) => b.generation - a.generation)) {
    const when = new Date(row.createdAt);
    const date = Number.isNaN(when.getTime())
      ? row.createdAt
      : when.toISOString().slice(0, 10);
    const privacy = row.privacyMode === 'protected' ? 'Protected' : 'Standard';
    lines.push(
      `  #${String(row.generation).padEnd(3)} ${date}   ${privacy.padEnd(9)} ${bytesLabel(
        row.payloadBytes,
      ).padStart(8)}${row.latest ? '   latest' : ''}`,
    );
  }
  lines.push(
    '',
    'Recover a previous backup with `stak memory recover --backup <n>`.',
  );
  return `${lines.join('\n').trimEnd()}\n`;
};

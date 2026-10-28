import type {
  EnvironmentCloudSyncState,
  InitializeMainEnvironmentResult,
} from '@stack/core';
import type {
  AgentId,
  EnvironmentDiff,
  EnvironmentStatus,
  SkillStatus,
} from '@stack/spec';
import type {
  CanonicalMemoryProjectStatus,
  MemoryWorkingTreeStatus,
  UnlocatableProject,
} from '../memory/working-tree-status.js';

/** `stak status`'s Memory section, widened (additively) to also carry canonical
 * (Project) Memory summaries — set by `program.ts`'s `checkMemory` dependency,
 * read by `renderCanonicalMemorySection` below. The existing `MemoryWorkingTreeStatus`
 * union itself is untouched; this is purely a display-layer extension of the single
 * object `stak status` already threads through as `memory`. */
export type MemoryStatusDisplay = MemoryWorkingTreeStatus & {
  canonicalProjects?: CanonicalMemoryProjectStatus[];
  /** Locatable project-scope identities discovered on this machine with no
   * registered Project ID yet — `stak add .` would mint and import them. */
  newProjects?: number;
  /** Project identities with genuinely ambiguous resolution (more than one existing
   * Project ID claims or is bound to the same identity) — never counted in
   * `newProjects`. No existing `stak project` subcommand can merge/remove a claim,
   * so this is a standing conflict STAK won't guess at, not something to "resolve". */
  conflictedProjects?: number;
  /** REGISTERED project identities whose directory could not be located at all —
   * named and actionable: `stak project map <project> <dir>` is the escape hatch. */
  unlocatableProjects?: UnlocatableProject[];
  /** Stale Claude memory folders with no Project ID at all AND no locatable
   * directory — quieter and un-actionable, distinct from `unlocatableProjects`. */
  untrackedFolders?: number;
  /** The v1 -> canonical migration hasn't run yet, so no per-project pending count
   * is meaningful — see `canonicalMemoryStatus`'s `upgradePending` doc comment. */
  upgradePending?: boolean;
};

import type { AgentMemoryStatusReport } from '../memory/agent-export-ops.js';
import { agentMemoryStatusLines } from './agent-memory.js';
import {
  agentLabel,
  block,
  changes,
  localMemoryConflictAdvice,
  skills,
} from './format.js';

export type RenderOptions = { verbose?: boolean };
export type AgentReadiness = { agent: AgentId; ready: boolean };
export type CloudSyncDisplayState =
  | EnvironmentCloudSyncState
  | { status: 'not-checked'; reason: 'offline' | 'unauthenticated' }
  /** STAK Cloud responded, but this CLI version could not read it (e.g. a
   * compatibility/schema problem) — distinct from "offline": the network and auth are
   * fine, the DATA is the problem. Never collapse this into "offline". */
  | { status: 'unavailable' };

/**
 * Memory's Cloud awareness is deliberately narrower than Skills': there is no cheap
 * digest to compare against (unlike Skills' environment version), so this only ever
 * reports whether a Cloud backup exists at all — it never claims Memory is "up to date",
 * which would overclaim what's actually known. Combined with the separate Memory
 * (MACHINE-vs-MAIN) section, the user gets an honest picture without a new subsystem.
 */
export type MemoryCloudDisplayState =
  | { status: 'not-checked' }
  | { status: 'no-backup' }
  | { status: 'backed-up'; generation: number; historicalRecovery: boolean };

const cloudLine = (cloud: CloudSyncDisplayState): string => {
  switch (cloud.status) {
    case 'up-to-date':
      return 'up to date with main';
    case 'ahead':
      return 'main has changes to push';
    case 'behind':
      return `newer version available (v${cloud.remoteVersionNumber}) — run \`stak pull\``;
    case 'no-remote':
      return 'nothing pushed yet';
    case 'diverged':
      return 'diverged from main — review with `stak diff`, then `stak pull` or `stak push`';
    case 'not-checked':
      return `not checked (${cloud.reason})`;
    case 'unavailable':
      return 'unavailable (Cloud response could not be read)';
  }
};
const memoryCloudLine = (memoryCloud: MemoryCloudDisplayState): string => {
  switch (memoryCloud.status) {
    case 'not-checked':
      return 'not checked';
    case 'no-backup':
      return 'nothing pushed yet';
    case 'backed-up':
      return memoryCloud.historicalRecovery
        ? `backed up (generation ${memoryCloud.generation}) — behind the latest; run \`stak memory recover\``
        : `backed up (generation ${memoryCloud.generation})`;
  }
};
/**
 * The Cloud section is always explicitly scoped per domain — Skills and Memory sync
 * independently, so a combined "up to date with Cloud" claim would be misleading
 * whenever one is synced and the other is not (e.g. staged Memory not yet pushed).
 */
const renderCloudSection = (
  cloud?: CloudSyncDisplayState,
  memoryCloud?: MemoryCloudDisplayState,
): string[] =>
  cloud
    ? [
        '',
        'Cloud',
        `  Skills   ${cloudLine(cloud)}`,
        ...(memoryCloud ? [`  Memory   ${memoryCloudLine(memoryCloud)}`] : []),
      ]
    : [];

const memoryLine = (memory: MemoryWorkingTreeStatus): string => {
  switch (memory.state) {
    case 'no-manifest':
      return `${memory.discovered} file${memory.discovered === 1 ? '' : 's'} discovered`;
    case 'clean':
      return 'clean';
    case 'changes-not-added':
      return `${memory.changed} change${memory.changed === 1 ? '' : 's'} not added`;
  }
};
/** Canonical (Project) Memory status — one line per bound project that has any
 * pending (not-yet-added) changes, conflicts, source conflicts, or guarded
 * (to-be-regenerated) paths. A clean project stays silent, matching this file's
 * existing `'clean'` convention for `MemoryWorkingTreeStatus` itself. */
const canonicalMemoryLines = (
  projects: CanonicalMemoryProjectStatus[],
): string[] => {
  const lines: string[] = [];
  for (const project of projects) {
    const totalConflicts =
      project.conflicts.length + project.sourceConflicts.length;
    if (
      project.pending === 0 &&
      totalConflicts === 0 &&
      project.guardedPaths.length === 0
    )
      continue;
    if (project.pending > 0)
      lines.push(
        `  ${project.projectId}: ${project.pending} change${project.pending === 1 ? '' : 's'} not added — run \`stak add .\``,
      );
    if (totalConflicts > 0) {
      // Final review I4: a local agent-vs-STAK conflict, never a Cloud merge
      // conflict — give the action that actually clears each one.
      lines.push(
        `  ${project.projectId}: ${totalConflicts} conflict${totalConflicts === 1 ? '' : 's'} between agent files and STAK (nothing was overwritten):`,
      );
      for (const conflict of project.conflicts)
        lines.push(
          `    ${conflict.path}: ${localMemoryConflictAdvice(conflict.reason)}`,
        );
      for (const conflictPath of project.sourceConflicts)
        lines.push(
          `    ${conflictPath}: ${localMemoryConflictAdvice('source-conflict')}`,
        );
    }
    if (project.guardedPaths.length > 0)
      lines.push(
        `  ${project.projectId}: ${project.guardedPaths.length} path${project.guardedPaths.length === 1 ? '' : 's'} will be regenerated — run \`stak memory materialize\``,
      );
  }
  return lines;
};

const renderMemorySection = (memory?: MemoryStatusDisplay): string[] => {
  if (!memory) return [];
  const lines = [`  ${memoryLine(memory)}`];
  if (memory.upgradePending) {
    // Planning against the canonical store before migration has ever run would be
    // meaningless (every claimed project would show as "pending" against an empty
    // store) — a single, distinct line instead of a misleading per-project count.
    lines.push(
      '  upgrade pending — run `stak add .` to move project Memory into STAK',
    );
    return ['', 'Memory', ...lines];
  }
  if (memory.canonicalProjects?.length)
    lines.push(...canonicalMemoryLines(memory.canonicalProjects));
  if (memory.newProjects)
    lines.push(
      `  ${memory.newProjects} new project${memory.newProjects === 1 ? '' : 's'} not added yet — run \`stak add .\``,
    );
  if (memory.conflictedProjects)
    lines.push(
      `  ${memory.conflictedProjects} project${memory.conflictedProjects === 1 ? '' : 's'} have conflicting identities — STAK won't guess which is correct; left unchanged`,
    );
  if (memory.unlocatableProjects?.length)
    lines.push(
      `  ${memory.unlocatableProjects.length} project${memory.unlocatableProjects.length === 1 ? '' : 's'} couldn't be located on this machine` +
        ` (${memory.unlocatableProjects.map((p) => p.name).join(', ')})` +
        ' — run `stak project map <project> <dir>`',
    );
  if (memory.untrackedFolders)
    lines.push(
      `  ${memory.untrackedFolders} Claude memory folder${memory.untrackedFolders === 1 ? '' : 's'} have no project folder on this machine and aren't tracked`,
    );
  return ['', 'Memory', ...lines];
};

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const renderInitVerbose = (result: InitializeMainEnvironmentResult): string =>
  block([
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
    '',
    'main created.',
    '',
    'No source Skill files were modified.',
  ]);

export const renderInitResult = (
  result: InitializeMainEnvironmentResult,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderInitVerbose(result);
  if (result.importedSkills === 0)
    return block([
      'Initialized STAK.',
      '',
      'No skills found yet.',
      'Add Skills to your agents, then run `stak init` again.',
    ]);
  return block([
    'Initialized STAK.',
    '',
    `Found ${skills(result.importedSkills)}.`,
    'Saved them to main.',
  ]);
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Skills that are in `main` but were never installed on this machine — the normal state
 * right after `stak pull` on a new machine. Not a change to add and NOT a deletion, so
 * this line must never suggest `stak remove`; `stak run <agent>` sets them up.
 */
const notInstalledLine = (count: number): string =>
  `${skills(count)} in main not installed here yet. Run \`stak run <agent>\` (e.g. \`stak run codex\`) to set ${count === 1 ? 'it' : 'them'} up.`;

const skillLines = (title: string, marker: string, list: SkillStatus[]) => {
  const matching = list.filter((skill) => skill.state === title.toLowerCase());
  return matching.length === 0
    ? []
    : ['', title, ...matching.map((skill) => `${marker} ${skill.name}`)];
};

const renderStatusVerbose = (status: EnvironmentStatus): string => {
  const summary = status.summary;
  const lines = [
    `Environment: ${status.environment}`,
    '',
    `Direct Skills    ${status.skills.filter((skill) => skill.origins?.some((origin) => origin.type === 'direct')).length}`,
    `STAK layers      ${status.stacks?.length ?? 0}`,
    `Resolved Skills  ${status.desiredCount}`,
    '',
    `Satisfied      ${summary.satisfied}`,
    `Modified       ${summary.modified}`,
    `Missing        ${summary.missing}`,
    `Not installed  ${summary.notInstalled}`,
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
      'STAKs',
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
  const notInstalled = status.skills.filter(
    (skill) => skill.state === 'not-installed',
  );
  if (notInstalled.length > 0)
    lines.push(
      '',
      'Not installed here',
      ...notInstalled.map((skill) => `  ${skill.name}`),
      '',
      notInstalledLine(notInstalled.length),
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
  lines.push('', 'No changes were made.');
  return block(lines);
};

export const renderStatus = (
  status: EnvironmentStatus,
  options: RenderOptions & {
    agents?: AgentReadiness[];
    cloud?: CloudSyncDisplayState;
    memory?: MemoryStatusDisplay;
    memoryCloud?: MemoryCloudDisplayState;
    agentMemory?: AgentMemoryStatusReport;
  } = {},
): string => {
  if (options.verbose) return renderStatusVerbose(status);
  const summary = status.summary;
  const named = (state: SkillStatus['state']) =>
    status.skills.filter((skill) => skill.state === state);
  const modified = named('modified');
  const missing = named('missing');
  const uncertain = named('uncertain');
  // Tracked in main but never installed here: not a change to add, not a deletion.
  const notInstalled = named('not-installed');
  const tracked = summary.satisfied + notInstalled.length;
  const hasChanges =
    summary.untracked > 0 ||
    modified.length > 0 ||
    missing.length > 0 ||
    uncertain.length > 0;

  const lines: Array<string | false> = [`STAK: ${status.environment}`, ''];
  if (!hasChanges) {
    lines.push(`Nothing to add. ${skills(tracked)} tracked.`);
  } else {
    lines.push('Changes not added', '', 'Skills');
    for (const skill of modified) lines.push(`  ~ ${skill.name}`);
    for (const skill of missing)
      lines.push(`  ! ${skill.name}  (tracked in main, missing on disk)`);
    for (const skill of uncertain)
      lines.push(`  ? ${skill.name}  (could not be verified)`);
    for (const skill of status.untracked) lines.push(`  + ${skill.name}`);
    lines.push(
      '',
      `${tracked} tracked`,
      summary.untracked > 0 && `${summary.untracked} untracked`,
    );
    if (missing.length > 0)
      lines.push(
        '',
        'Run `stak remove <skill>` to deliberately drop a missing Skill from main.',
      );
    lines.push('', 'Run `stak add <skill>` or `stak add .` to stage changes.');
  }
  if (notInstalled.length > 0)
    lines.push('', notInstalledLine(notInstalled.length));
  if (status.invalidSkills.length > 0)
    lines.push(
      '',
      `${status.invalidSkills.length} invalid discovered Skill${status.invalidSkills.length === 1 ? '' : 's'} (not addable; run \`stak scan --verbose\` for details)`,
    );
  lines.push(...renderMemorySection(options.memory));
  lines.push(...agentMemoryStatusLines(options.agentMemory));
  lines.push(...renderCloudSection(options.cloud, options.memoryCloud));
  if (options.agents && options.agents.length > 0) {
    lines.push('');
    for (const agent of options.agents)
      lines.push(
        `${agentLabel(agent.agent).padEnd(9)}${agent.ready ? 'ready' : 'not set up'}`,
      );
  }
  return block(lines);
};

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const sourceLabel = (source: SkillStatus['desiredSource']): string => {
  if (!source) return 'ambiguous or unavailable';
  if (source.type === 'git')
    return `${source.remote ?? 'local git repository'} @ ${source.revision} (${source.path})`;
  return source.type;
};

const renderDiffVerbose = (diff: EnvironmentDiff): string => {
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
            : `STAK: ${origin.stackName}`,
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
  lines.push('', 'No changes were made.');
  return block(lines);
};

const groupNames = (diff: EnvironmentDiff, state: string): string[] =>
  diff.entries
    .filter((entry) => entry.state === state)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

export const renderDiff = (
  diff: EnvironmentDiff,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderDiffVerbose(diff);
  const missing = groupNames(diff, 'missing');
  const modified = groupNames(diff, 'modified');
  const uncertain = groupNames(diff, 'uncertain');
  const untracked = diff.untracked
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));
  const notInstalled = diff.entries.filter(
    (entry) => entry.state === 'not-installed',
  ).length;
  const notInstalledNote =
    notInstalled > 0 ? ['', notInstalledLine(notInstalled)] : [];
  const total =
    missing.length + modified.length + uncertain.length + untracked.length;
  if (total === 0) return block(['No changes.', ...notInstalledNote]);
  const group = (title: string, names: string[]) =>
    names.length > 0 ? ['', title, ...names.map((name) => `  ${name}`)] : [];
  return block([
    changes(total),
    ...group('Untracked', untracked),
    ...group('Missing', missing),
    ...group('Modified', modified),
    ...group('Uncertain', uncertain),
    ...notInstalledNote,
  ]);
};

/**
 * Cross-agent Project Memory, CLI side (spec 2026-10-28 §7–§8).
 *
 * Wires `@stack/memory`'s exporter into STAK's commands:
 *  - `exportAgentMemory` refreshes every enabled agent's file for every located
 *    project (after add / pull / push / backup / final resolve / materialize /
 *    recover);
 *  - `enableAgentMemory` / `disableAgentMemory` / `resetAgentMemory` back
 *    `stak run codex|cursor` and `stak memory agents enable|disable|reset`;
 *  - `agentMemoryStatus` is the read-only status behind `stak status`,
 *    `stak memory status` and `stak memory agents`.
 *
 * Rules:
 *  - Nothing here takes the Memory lock. Callers run these inside their own
 *    locked span (the post-command check-in never calls them).
 *  - Nothing here throws. Every problem becomes a note, so exporting can never
 *    change a command's exit code (§8).
 *  - Each project is exported to exactly one folder per run: the same folder
 *    materialize writes to. A project found in more than one folder, or a folder
 *    claimed by more than one project, is skipped with a note.
 */
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_EXPORT_IDS,
  AGENT_EXPORT_RELATIVE_PATHS,
  AgentExportStateError,
  agentExportPaths,
  defaultGitRunner,
  exportProjectMemory,
  exportStatus,
  isTrackedByGit,
  locateGitRepository,
  nameHintFor,
  projectMemoryOf,
  readCanonicalMain,
  readExportSettings,
  readExportState,
  readLocalRegistry,
  readMemoryObject,
  removeProjectExport,
  renderAgentMemory,
  shortProjectId,
  writeExportSettings,
  type AgentExportId,
  type AgentExportState,
  type AgentMemoryDocument,
  type CanonicalMainManifest,
  type ExportStatusCode,
  type GitRunner,
  type LocalRegistry,
  type RenderAgentMemoryResult,
} from '@stack/memory';

import {
  locateMaterializeTargets,
  type CanonicalDiscoveryOptions,
} from './canonical-ops.js';

export { AGENT_EXPORT_IDS, type AgentExportId } from '@stack/memory';

export const isAgentExportId = (value: string): value is AgentExportId =>
  (AGENT_EXPORT_IDS as readonly string[]).includes(value);

/** A project an export run did not write, and why. */
export type AgentExportProjectNote = {
  projectId: string;
  name: string;
  status:
    Exclude<ExportStatusCode, 'written' | 'unchanged'> | 'skipped-ambiguous';
  message?: string;
};

export type AgentExportAgentReport = {
  agent: AgentExportId;
  written: number;
  unchanged: number;
  skipped: AgentExportProjectNote[];
  /** Projects whose file left whole notes out to fit the budget (spec §4.2). */
  overBudget: Array<{ projectId: string; name: string; omitted: string[] }>;
};

export type AgentExportProblem = {
  code: 'state-corrupt' | 'settings-corrupt' | 'failed';
  message: string;
};

export type AgentExportReport = {
  agents: AgentExportAgentReport[];
  problems: AgentExportProblem[];
};

export type AgentDisableReport = {
  agent: AgentExportId;
  removed: number;
  /** Hand-edited STAK files left in place (including ones at a project's old
   * folder). They keep their exclude lines, so they stay out of Git. */
  kept: Array<{ projectId: string; name: string }>;
  failed: Array<{ projectId: string; name: string; message: string }>;
  problems: AgentExportProblem[];
};

export type AgentResetReport = AgentExportReport & { enabled: boolean };

type ExportOptions = {
  git?: GitRunner;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Shared helpers

const nameOf = (registry: LocalRegistry, projectId: string): string =>
  nameHintFor(registry, projectId) ?? shortProjectId(projectId);

const commandAgent = (agents: readonly AgentExportId[]): string =>
  agents.length === 1 ? (agents[0] as string) : '<agent>';

/** Any error from the exporter's state or settings files, as a note that says
 * how to recover. */
export const agentExportProblemOf = (
  stackHome: string,
  error: unknown,
  agents: readonly AgentExportId[] = [],
): AgentExportProblem => {
  const paths = agentExportPaths(stackHome);
  if (error instanceof AgentExportStateError)
    return error.code === 'state-corrupt'
      ? {
          code: 'state-corrupt',
          message: `Agent memory sharing skipped: STAK's record of the agent files it wrote is unreadable. Delete ${paths.state}, then run \`stak memory agents reset ${commandAgent(agents)}\`.`,
        }
      : {
          code: 'settings-corrupt',
          message: `Agent memory sharing skipped: STAK's agent memory settings are unreadable. Delete ${paths.settings}, then run \`stak memory agents enable ${commandAgent(agents)}\`.`,
        };
  return {
    code: 'failed',
    message: `Agent memory sharing skipped: ${error instanceof Error ? error.message : String(error)}`,
  };
};

/**
 * The command layer's guard (spec §8): run an export dependency, turning
 * anything it throws into a note. `undefined` when the dependency is absent.
 */
export const safelyExportAgentMemory = async (
  run: (() => Promise<AgentExportReport>) | undefined,
): Promise<AgentExportReport | undefined> => {
  if (!run) return undefined;
  try {
    return await run();
  } catch (error) {
    return {
      agents: [],
      problems: [
        {
          code: 'failed',
          message: `Agent memory sharing skipped: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
};

const enabledAgentsOf = async (stackHome: string): Promise<AgentExportId[]> => {
  const settings = await readExportSettings(stackHome);
  return AGENT_EXPORT_IDS.filter((agent) => settings.enabled[agent] === true);
};

/** Spec §4.1: present `notes/**` and `instructions/private.md` documents only,
 * with their text from the object store. Never `agents/**`. */
const exportDocumentsOf = async (
  stackHome: string,
  main: CanonicalMainManifest,
  projectId: string,
): Promise<AgentMemoryDocument[]> => {
  const documents: AgentMemoryDocument[] = [];
  for (const doc of projectMemoryOf(main, projectId)?.documents ?? []) {
    if (doc.state !== 'present') continue;
    if (
      doc.path !== 'instructions/private.md' &&
      !doc.path.startsWith('notes/')
    )
      continue;
    const bytes = await readMemoryObject({
      stackHome,
      contentHash: doc.contentHash,
    });
    documents.push({
      path: doc.path,
      text: Buffer.from(bytes).toString('utf8'),
    });
  }
  return documents;
};

type ExportTarget = { projectId: string; name: string; dir: string };
type SkippedTarget = { projectId: string; name: string; message: string };

/**
 * The single folder each project is exported to this run — the folder
 * materialize uses. Skipped instead: a project found in more than one folder,
 * and every project of a folder more than one project resolves to.
 */
const planTargets = async (
  stackHome: string,
  discovery: CanonicalDiscoveryOptions,
  registry: LocalRegistry,
): Promise<{ targets: ExportTarget[]; skipped: SkippedTarget[] }> => {
  const platform = discovery.platform ?? process.platform;
  const { targets, ambiguous } = await locateMaterializeTargets(
    stackHome,
    discovery,
  );
  const keyOf = (dir: string) => {
    const resolved = path.resolve(dir);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const byFolder = new Map<string, string[]>();
  for (const [projectId, dir] of targets) {
    if (ambiguous.has(projectId)) continue;
    const ids = byFolder.get(keyOf(dir)) ?? [];
    ids.push(projectId);
    byFolder.set(keyOf(dir), ids);
  }
  const out: ExportTarget[] = [];
  const skipped: SkippedTarget[] = [];
  for (const [projectId, dir] of targets) {
    const name = nameOf(registry, projectId);
    const dirs = ambiguous.get(projectId);
    if (dirs) {
      skipped.push({
        projectId,
        name,
        message: `found in more than one folder (${dirs.join(', ')}). Choose one with \`stak project map ${projectId} <dir>\``,
      });
      continue;
    }
    if ((byFolder.get(keyOf(dir)) ?? []).length > 1) {
      skipped.push({
        projectId,
        name,
        message: `its folder ${path.resolve(dir)} also belongs to another project. Choose with \`stak project map <project> <dir>\``,
      });
      continue;
    }
    out.push({ projectId, name, dir: path.resolve(dir) });
  }
  return { targets: out, skipped };
};

// ---------------------------------------------------------------------------
// Export

/**
 * Write (or refresh) every enabled agent's Memory file for every located
 * project. `agents` narrows the run to those agents (still only enabled ones).
 * Never throws; never takes the Memory lock.
 */
export const exportAgentMemory = async (
  stackHome: string,
  discovery: CanonicalDiscoveryOptions,
  options: ExportOptions & {
    agents?: readonly AgentExportId[];
    overwriteHandEdits?: boolean;
  } = {},
): Promise<AgentExportReport> => {
  const problems: AgentExportProblem[] = [];
  const reports: AgentExportAgentReport[] = [];
  let agents: AgentExportId[] = [];
  try {
    agents = (await enabledAgentsOf(stackHome)).filter(
      (agent) => !options.agents || options.agents.includes(agent),
    );
    if (agents.length === 0) return { agents: [], problems };
    // A corrupt state file would fail every project: say once how to fix it.
    const state = await readExportState(stackHome);
    const registry = await readLocalRegistry(stackHome);
    const main = await readCanonicalMain(stackHome);
    const { targets, skipped } = await planTargets(
      stackHome,
      discovery,
      registry,
    );
    // Documents are read once per project and shared by both agents.
    const documents = new Map<string, AgentMemoryDocument[] | Error>();
    for (const target of targets)
      try {
        documents.set(
          target.projectId,
          await exportDocumentsOf(stackHome, main, target.projectId),
        );
      } catch (error) {
        documents.set(
          target.projectId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }

    for (const agent of agents) {
      const report: AgentExportAgentReport = {
        agent,
        written: 0,
        unchanged: 0,
        skipped: skipped.map((s) => ({
          projectId: s.projectId,
          name: s.name,
          status: 'skipped-ambiguous',
          message: s.message,
        })),
        overBudget: [],
      };
      for (const target of targets) {
        const docs = documents.get(target.projectId);
        if (docs instanceof Error) {
          report.skipped.push({
            projectId: target.projectId,
            name: target.name,
            status: 'failed',
            message: docs.message,
          });
          continue;
        }
        // A project with no shareable Memory gets no file — unless STAK wrote
        // one before, which must then be refreshed (emptied).
        if (
          (docs ?? []).length === 0 &&
          !hasRecord(state, target.projectId, agent)
        )
          continue;
        const result = await exportProjectMemory({
          stackHome,
          projectId: target.projectId,
          projectDir: target.dir,
          agent,
          documents: docs ?? [],
          ...(options.git ? { git: options.git } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.overwriteHandEdits ? { overwriteHandEdits: true } : {}),
        });
        if (result.status === 'written' || result.status === 'unchanged') {
          report[result.status] += 1;
          if (result.omitted.length > 0)
            report.overBudget.push({
              projectId: target.projectId,
              name: target.name,
              omitted: result.omitted,
            });
        } else
          report.skipped.push({
            projectId: target.projectId,
            name: target.name,
            status: result.status,
            ...(result.message !== undefined
              ? { message: result.message }
              : {}),
          });
      }
      reports.push(report);
    }
  } catch (error) {
    problems.push(agentExportProblemOf(stackHome, error, agents));
  }
  return { agents: reports, problems };
};

const hasRecord = (
  state: AgentExportState,
  projectId: string,
  agent: AgentExportId,
): boolean =>
  state.projects[projectId]?.[agent] !== undefined ||
  (state.retired ?? []).some(
    (record) => record.projectId === projectId && record.agent === agent,
  );

/** `stak run codex|cursor` and `stak memory agents enable`: turn sharing on
 * for `agent`, then export it right away. */
export const enableAgentMemory = async (
  stackHome: string,
  discovery: CanonicalDiscoveryOptions,
  agent: AgentExportId,
  options: ExportOptions = {},
): Promise<AgentExportReport> => {
  try {
    const settings = await readExportSettings(stackHome);
    if (settings.enabled[agent] !== true)
      await writeExportSettings(stackHome, {
        enabled: { ...settings.enabled, [agent]: true },
      });
  } catch (error) {
    return {
      agents: [],
      problems: [agentExportProblemOf(stackHome, error, [agent])],
    };
  }
  return exportAgentMemory(stackHome, discovery, {
    ...options,
    agents: [agent],
  });
};

/** `stak memory agents reset <agent>`: rewrite STAK's own files for `agent`,
 * hand edits included (spec §6). Never touches a file STAK did not write. */
export const resetAgentMemory = async (
  stackHome: string,
  discovery: CanonicalDiscoveryOptions,
  agent: AgentExportId,
  options: ExportOptions = {},
): Promise<AgentResetReport> => {
  try {
    if (!(await enabledAgentsOf(stackHome)).includes(agent))
      return { enabled: false, agents: [], problems: [] };
  } catch (error) {
    return {
      enabled: false,
      agents: [],
      problems: [agentExportProblemOf(stackHome, error, [agent])],
    };
  }
  return {
    enabled: true,
    ...(await exportAgentMemory(stackHome, discovery, {
      ...options,
      agents: [agent],
      overwriteHandEdits: true,
    })),
  };
};

/** The project folder a recorded file belongs to. */
const projectDirOfRecord = (file: string, agent: AgentExportId): string =>
  path.resolve(
    file,
    ...AGENT_EXPORT_RELATIVE_PATHS[agent].split('/').map(() => '..'),
  );

/**
 * `stak memory agents disable <agent>` (spec §7 "Off"): clear the setting, then
 * delete every file STAK wrote for `agent` that is unchanged (and release its
 * exclude lines). A hand-edited file stays, recorded and excluded from Git.
 */
export const disableAgentMemory = async (
  stackHome: string,
  agent: AgentExportId,
): Promise<AgentDisableReport> => {
  const report: AgentDisableReport = {
    agent,
    removed: 0,
    kept: [],
    failed: [],
    problems: [],
  };
  // The setting first: if cleanup stops part way, nothing writes the files again.
  try {
    const { enabled } = await readExportSettings(stackHome);
    if (enabled[agent] !== undefined)
      await writeExportSettings(stackHome, {
        enabled: Object.fromEntries(
          Object.entries(enabled).filter(([id]) => id !== agent),
        ),
      });
  } catch (error) {
    report.problems.push(agentExportProblemOf(stackHome, error, [agent]));
  }
  let registry: LocalRegistry | undefined;
  try {
    registry = await readLocalRegistry(stackHome);
  } catch {
    registry = undefined;
  }
  const nameFor = (projectId: string) =>
    registry ? nameOf(registry, projectId) : shortProjectId(projectId);
  try {
    const state = await readExportState(stackHome);
    // Current records first; each call also sweeps that project's retired files.
    const entries = new Map<string, { projectId: string; dir: string }>();
    for (const [projectId, records] of Object.entries(state.projects)) {
      const record = records[agent];
      if (record)
        entries.set(`${projectId}\n${record.path}`, {
          projectId,
          dir: projectDirOfRecord(record.path, agent),
        });
    }
    for (const record of state.retired ?? [])
      if (record.agent === agent)
        entries.set(`${record.projectId}\n${record.path}`, {
          projectId: record.projectId,
          dir: projectDirOfRecord(record.path, agent),
        });
    const keptIds = new Set<string>();
    for (const { projectId, dir } of entries.values()) {
      try {
        const { status } = await removeProjectExport({
          stackHome,
          projectId,
          projectDir: dir,
          agent,
        });
        if (status === 'removed') report.removed += 1;
        if (status === 'kept-hand-edited') keptIds.add(projectId);
      } catch (error) {
        if (error instanceof AgentExportStateError) throw error;
        report.failed.push({
          projectId,
          name: nameFor(projectId),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A later sweep may have cleared what an earlier call kept: re-check.
    const after = await readExportState(stackHome);
    for (const projectId of keptIds)
      if (hasRecord(after, projectId, agent))
        report.kept.push({ projectId, name: nameFor(projectId) });
  } catch (error) {
    report.problems.push(agentExportProblemOf(stackHome, error, [agent]));
  }
  return report;
};

// ---------------------------------------------------------------------------
// Status (read-only)

export type AgentProjectState =
  'up-to-date' | 'out-of-date' | 'hand-edited' | 'not-ignorable' | 'skipped';

export type AgentMemoryAgentStatus = {
  agent: AgentExportId;
  enabled: boolean;
  /** Located projects with shareable Memory (or a STAK file). */
  projects: number;
  upToDate: number;
  outOfDate: number;
  handEdited: number;
  notIgnorable: number;
  skipped: number;
  overBudget: number;
  /** Every project that is not plainly up to date, with what to do. */
  details: Array<{
    projectId: string;
    name: string;
    state: AgentProjectState;
    message?: string;
    omitted?: string[];
  }>;
};

export type AgentMemoryStatusReport = {
  agents: AgentMemoryAgentStatus[];
  problems: AgentExportProblem[];
};

const emptyAgentStatus = (
  agent: AgentExportId,
  enabled: boolean,
): AgentMemoryAgentStatus => ({
  agent,
  enabled,
  projects: 0,
  upToDate: 0,
  outOfDate: 0,
  handEdited: 0,
  notIgnorable: 0,
  skipped: 0,
  overBudget: 0,
  details: [],
});

const hasGitAncestor = async (dir: string): Promise<boolean> => {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return true;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

/** Whether a `.gitignore` "!" rule re-includes `relative` (read-only: Git's own
 * answer for the last pattern that matches it). */
const reIncludedByGit = async (
  git: GitRunner,
  dir: string,
  relative: string,
): Promise<boolean> => {
  const result = await git.run(dir, [
    'check-ignore',
    '-v',
    '-n',
    '--no-index',
    '--',
    relative,
  ]);
  if (result.exitCode !== 0 && result.exitCode !== 1) return false;
  const line = result.stdout.split('\n').find((l) => l.includes('\t')) ?? '';
  const pattern = /^.*?:\d+:(.*)\t/.exec(line)?.[1] ?? '';
  return pattern.startsWith('!');
};

const readTeamAgentsMd = async (dir: string): Promise<string | undefined> => {
  const file = path.join(dir, 'AGENTS.md');
  try {
    if (!(await stat(file)).isFile()) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** Why a never-written (or deleted) file is missing, read-only. */
const classifyMissing = async (
  git: GitRunner,
  dir: string,
  agent: AgentExportId,
  rendered: RenderAgentMemoryResult,
): Promise<{ state: AgentProjectState; message?: string }> => {
  const relative = AGENT_EXPORT_RELATIVE_PATHS[agent];
  if (rendered.status !== 'ok')
    return {
      state: 'skipped',
      message:
        'the team AGENTS.md alone is too large for Codex to also read STAK Memory',
    };
  const location = await locateGitRepository(git, dir);
  if (location.kind !== 'repo') {
    if (await hasGitAncestor(dir))
      return {
        state: 'skipped',
        message: `Git isn't available, so STAK can't keep ${relative} out of the repository`,
      };
    return { state: 'out-of-date', message: `${relative} not written yet` };
  }
  if (await isTrackedByGit(git, dir, relative))
    return { state: 'skipped', message: `${relative} is tracked by Git` };
  const name = path.posix.basename(relative);
  const tempProbe = path.posix.join(
    path.posix.dirname(relative),
    `.${name}.probe.tmp`,
  );
  if (
    (await reIncludedByGit(git, dir, relative)) ||
    (await reIncludedByGit(git, dir, tempProbe))
  )
    return {
      state: 'not-ignorable',
      message: `.gitignore re-includes ${relative}, so STAK won't write it`,
    };
  return { state: 'out-of-date', message: `${relative} not written yet` };
};

/**
 * Read-only status of every agent: on/off, and for an enabled agent how each
 * located project's file stands. Never writes, never throws.
 */
export const agentMemoryStatus = async (
  stackHome: string,
  discovery: CanonicalDiscoveryOptions,
  options: { git?: GitRunner } = {},
): Promise<AgentMemoryStatusReport> => {
  const git = options.git ?? defaultGitRunner;
  let enabled: AgentExportId[];
  try {
    enabled = await enabledAgentsOf(stackHome);
  } catch (error) {
    return {
      agents: AGENT_EXPORT_IDS.map((agent) => emptyAgentStatus(agent, false)),
      problems: [agentExportProblemOf(stackHome, error)],
    };
  }
  const agents = AGENT_EXPORT_IDS.map((agent) =>
    emptyAgentStatus(agent, enabled.includes(agent)),
  );
  if (enabled.length === 0) return { agents, problems: [] };
  try {
    const state = await readExportState(stackHome);
    const registry = await readLocalRegistry(stackHome);
    const main = await readCanonicalMain(stackHome);
    const { targets, skipped } = await planTargets(
      stackHome,
      discovery,
      registry,
    );
    for (const status of agents) {
      if (!status.enabled) continue;
      const { agent } = status;
      for (const s of skipped) {
        status.projects += 1;
        status.skipped += 1;
        status.details.push({
          projectId: s.projectId,
          name: s.name,
          state: 'skipped',
          message: s.message,
        });
      }
      for (const target of targets) {
        const add = (state: AgentProjectState, message?: string) => {
          status.projects += 1;
          if (state === 'up-to-date') status.upToDate += 1;
          if (state === 'out-of-date') status.outOfDate += 1;
          if (state === 'hand-edited') status.handEdited += 1;
          if (state === 'not-ignorable') status.notIgnorable += 1;
          if (state === 'skipped') status.skipped += 1;
          if (state !== 'up-to-date')
            status.details.push({
              projectId: target.projectId,
              name: target.name,
              state,
              ...(message !== undefined ? { message } : {}),
            });
        };
        try {
          const documents = await exportDocumentsOf(
            stackHome,
            main,
            target.projectId,
          );
          if (
            documents.length === 0 &&
            !hasRecord(state, target.projectId, agent)
          )
            continue;
          const team =
            agent === 'codex' ? await readTeamAgentsMd(target.dir) : undefined;
          const rendered = renderAgentMemory({
            agent,
            documents,
            ...(team !== undefined ? { teamAgentsMd: team } : {}),
          });
          const fresh = await exportStatus({
            stackHome,
            projectId: target.projectId,
            projectDir: target.dir,
            agent,
            documents,
          });
          const relative = AGENT_EXPORT_RELATIVE_PATHS[agent];
          if (fresh === 'up-to-date') add('up-to-date');
          else if (fresh === 'stale')
            add('out-of-date', `${relative} is out of date`);
          else if (fresh === 'hand-edited')
            add(
              'hand-edited',
              `${relative} was edited by hand. Move the edit into your memory, or run \`stak memory agents reset ${agent}\``,
            );
          else if (fresh === 'user-file')
            add(
              'skipped',
              `${relative} already exists and wasn't written by STAK`,
            );
          else {
            const missing = await classifyMissing(
              git,
              target.dir,
              agent,
              rendered,
            );
            add(missing.state, missing.message);
          }
          if (rendered.status === 'ok' && rendered.omitted.length > 0) {
            status.overBudget += 1;
            const detail = status.details.find(
              (d) => d.projectId === target.projectId,
            );
            if (detail) detail.omitted = rendered.omitted;
            else
              status.details.push({
                projectId: target.projectId,
                name: target.name,
                state: 'up-to-date',
                omitted: rendered.omitted,
              });
          }
        } catch (error) {
          if (error instanceof AgentExportStateError) throw error;
          add(
            'skipped',
            `couldn't check: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    return {
      agents: agents.map((a) =>
        a.enabled ? emptyAgentStatus(a.agent, true) : a,
      ),
      problems: [agentExportProblemOf(stackHome, error, enabled)],
    };
  }
  return { agents, problems: [] };
};

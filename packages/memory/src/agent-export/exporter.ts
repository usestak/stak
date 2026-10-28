/**
 * Cross-agent Project Memory exporter (spec 2026-10-28 §4–§8).
 *
 * Writes one project's rendered Memory into one agent's file inside the project
 * folder, keeps that file out of Git with the repo's local-only exclude list,
 * and records what it wrote in machine-local state so it only ever updates or
 * deletes its own, unchanged files.
 *
 * The exporter never takes the Memory lock: callers run it inside their own
 * locked span. `exportProjectMemory` never throws — every problem is a result.
 */
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertPathWithin, PathFenceError } from '@stack/shared';
import { z } from 'zod';

import { assertRootHasNoSymlinkSegments } from '../canonical/claude-project-adapter.js';
import { atomicWriteFile } from '../remote/secure-file.js';
import { hashBytes, memoryStorePaths } from '../store.js';
import {
  addGitExcludeEntry,
  defaultGitRunner,
  excludeEntryFor,
  isTrackedByGit,
  locateGitRepository,
  removeGitExcludeEntry,
  type GitRunner,
} from './git-exclude.js';
import {
  AGENT_EXPORT_IDS,
  renderAgentMemory,
  type AgentExportId,
  type AgentMemoryDocument,
} from './render.js';

/** Where each agent's file lives, relative to the project folder (POSIX). */
export const AGENT_EXPORT_RELATIVE_PATHS: Record<AgentExportId, string> = {
  codex: 'AGENTS.override.md',
  cursor: '.cursor/rules/stak-memory.mdc',
};

const AGENT_FILE_LABELS: Record<AgentExportId, string> = {
  codex: 'AGENTS.override.md',
  cursor: '.cursor/rules/stak-memory.mdc',
};

export const agentExportTargetOf = (
  projectDir: string,
  agent: AgentExportId,
): string =>
  path.join(projectDir, ...AGENT_EXPORT_RELATIVE_PATHS[agent].split('/'));

/** Machine-local; listed in `STATE_EXCLUDE_PATHS` so it never enters a bundle. */
export const agentExportPaths = (stackHome: string) => {
  const root = path.join(memoryStorePaths(stackHome).root, 'agent-exports');
  return {
    root,
    state: path.join(root, 'state.json'),
    settings: path.join(root, 'settings.json'),
  };
};

export class AgentExportStateError extends Error {
  constructor(
    public readonly code: 'state-corrupt' | 'settings-corrupt',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentExportStateError';
  }
}

// ---------------------------------------------------------------------------
// State and settings

const exportRecordSchema = z.object({
  /** Absolute path of the file STAK wrote. */
  path: z.string().min(1),
  /** `sha256:<hex>` of the exact bytes STAK last wrote. */
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** Codex: hash of the team `AGENTS.md` bytes it was built from (null when
   * there was none). Always null for Cursor. */
  agentsMdHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  /** The exclude line STAK added, so it can be removed without asking Git. */
  exclude: z
    .object({ file: z.string().min(1), entry: z.string().min(1) })
    .optional(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AgentExportRecord = z.infer<typeof exportRecordSchema>;

const exportStateSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({
      codex: exportRecordSchema.optional(),
      cursor: exportRecordSchema.optional(),
    }),
  ),
});
export type AgentExportState = z.infer<typeof exportStateSchema>;

const exportSettingsFileSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.object({
    codex: z.boolean().optional(),
    cursor: z.boolean().optional(),
  }),
});
export type AgentExportSettings = {
  enabled: { codex?: boolean; cursor?: boolean };
};

const readJson = async (file: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
};

const writeJson = (file: string, value: unknown): Promise<void> =>
  atomicWriteFile(
    file,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );

export const readExportState = async (
  stackHome: string,
): Promise<AgentExportState> => {
  try {
    const raw = await readJson(agentExportPaths(stackHome).state);
    if (raw === undefined) return { schemaVersion: 1, projects: {} };
    return exportStateSchema.parse(raw);
  } catch (error) {
    throw new AgentExportStateError(
      'state-corrupt',
      'The agent Memory export state is malformed.',
      { cause: error },
    );
  }
};

const writeExportState = (
  stackHome: string,
  state: AgentExportState,
): Promise<void> =>
  writeJson(agentExportPaths(stackHome).state, exportStateSchema.parse(state));

const updateRecord = async (
  stackHome: string,
  projectId: string,
  agent: AgentExportId,
  record: AgentExportRecord | undefined,
): Promise<void> => {
  const state = await readExportState(stackHome);
  const previous = state.projects[projectId] ?? {};
  const project = Object.fromEntries(
    AGENT_EXPORT_IDS.flatMap((id) => {
      const value = id === agent ? record : previous[id];
      return value ? [[id, value] as const] : [];
    }),
  );
  const projects = Object.fromEntries(
    Object.entries(state.projects).filter(([id]) => id !== projectId),
  );
  if (Object.keys(project).length > 0) projects[projectId] = project;
  await writeExportState(stackHome, { schemaVersion: 1, projects });
};

export const readExportSettings = async (
  stackHome: string,
): Promise<AgentExportSettings> => {
  try {
    const raw = await readJson(agentExportPaths(stackHome).settings);
    if (raw === undefined) return { enabled: {} };
    const { codex, cursor } = exportSettingsFileSchema.parse(raw).enabled;
    return {
      enabled: {
        ...(codex !== undefined ? { codex } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
    };
  } catch (error) {
    throw new AgentExportStateError(
      'settings-corrupt',
      'The agent Memory export settings are malformed.',
      { cause: error },
    );
  }
};

export const writeExportSettings = (
  stackHome: string,
  settings: AgentExportSettings,
): Promise<void> =>
  writeJson(
    agentExportPaths(stackHome).settings,
    exportSettingsFileSchema.parse({
      schemaVersion: 1,
      enabled: settings.enabled,
    }),
  );

// ---------------------------------------------------------------------------
// File helpers

type Existing =
  { kind: 'none' } | { kind: 'file'; bytes: Buffer } | { kind: 'other' };

/** What is at `target`, without following a symlink there. */
const readExisting = async (target: string): Promise<Existing> => {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'none' };
    throw error;
  }
  if (!info.isFile()) return { kind: 'other' };
  return { kind: 'file', bytes: await readFile(target) };
};

/** The destination must stay inside `projectDir`, and no symlink may sit at
 * `.cursor`, `.cursor/rules` or the target file itself. */
const assertTargetSafe = async (
  projectDir: string,
  target: string,
): Promise<void> => {
  await assertRootHasNoSymlinkSegments(projectDir, path.dirname(target));
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new PathFenceError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await assertPathWithin({ ownedRoot: projectDir, proposedPath: target });
};

/** Whether `dir` or any ancestor has a `.git` entry (file or folder). */
const hasGitAncestor = async (dir: string): Promise<boolean> => {
  let current = dir;
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

const readTeamAgentsMd = async (
  projectDir: string,
): Promise<{ text: string; hash: string } | undefined> => {
  const file = path.join(projectDir, 'AGENTS.md');
  let bytes: Buffer;
  try {
    // A symlinked AGENTS.md (for example to CLAUDE.md) is common; reading it
    // is fine, STAK never writes it.
    if (!(await stat(file)).isFile()) return undefined;
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return { text: bytes.toString('utf8'), hash: hashBytes(bytes) };
};

const messageOf = (error: unknown): string =>
  error instanceof PathFenceError
    ? 'Refusing to write through a symbolic link or outside the project folder.'
    : error instanceof Error
      ? error.message
      : String(error);

// ---------------------------------------------------------------------------
// Export

export type ExportStatusCode =
  | 'written'
  | 'unchanged'
  | 'skipped-user-file'
  | 'skipped-hand-edited'
  | 'skipped-tracked'
  | 'skipped-no-git'
  | 'skipped-team-too-large'
  | 'failed';

export type ExportResult = {
  status: ExportStatusCode;
  path: string;
  omitted: string[];
  message?: string;
};

export type ExportProjectMemoryOptions = {
  stackHome: string;
  projectId: string;
  projectDir: string;
  agent: AgentExportId;
  /** Present `notes/**` and `instructions/private.md` documents only. */
  documents: ReadonlyArray<AgentMemoryDocument>;
  git?: GitRunner;
  now?: () => Date;
  /** `stak memory agents reset`: rewrite STAK's own file even if it was edited
   * by hand. Never applies to a file STAK did not write. */
  overwriteHandEdits?: boolean;
};

type Privacy =
  | { kind: 'plain' }
  | { kind: 'exclude'; file: string; entry: string }
  | {
      kind: 'skip';
      status: 'skipped-no-git' | 'skipped-tracked';
      message: string;
    };

const resolvePrivacy = async (
  git: GitRunner,
  projectDir: string,
  agent: AgentExportId,
): Promise<Privacy> => {
  const location = await locateGitRepository(git, projectDir);
  if (location.kind !== 'repo') {
    if (!(await hasGitAncestor(projectDir))) return { kind: 'plain' };
    return {
      kind: 'skip',
      status: 'skipped-no-git',
      message:
        location.kind === 'no-git'
          ? 'Git is not available, so STAK cannot keep this file out of the repository.'
          : 'Git could not read this repository, so STAK cannot keep this file out of it.',
    };
  }
  const relative = AGENT_EXPORT_RELATIVE_PATHS[agent];
  if (await isTrackedByGit(git, projectDir, relative))
    return {
      kind: 'skip',
      status: 'skipped-tracked',
      message: `${AGENT_FILE_LABELS[agent]} is tracked by Git; STAK will not write a file that could be committed.`,
    };
  const fromRoot = path.relative(
    await realpath(location.toplevel),
    await realpath(projectDir),
  );
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error('The project folder is outside its Git working tree.');
  const segments = [
    ...fromRoot.split(path.sep).filter((segment) => segment.length > 0),
    relative,
  ];
  return {
    kind: 'exclude',
    file: location.excludePath,
    entry: excludeEntryFor(segments.join('/')),
  };
};

const sameExclude = (
  a: AgentExportRecord['exclude'],
  b: AgentExportRecord['exclude'],
): boolean => a?.file === b?.file && a?.entry === b?.entry;

const exportOnce = async (
  options: ExportProjectMemoryOptions,
  projectDir: string,
  target: string,
): Promise<ExportResult> => {
  const { stackHome, projectId, agent } = options;
  const git = options.git ?? defaultGitRunner;
  const label = AGENT_FILE_LABELS[agent];
  const result = (
    status: ExportStatusCode,
    message?: string,
    omitted: string[] = [],
  ): ExportResult => ({
    status,
    path: target,
    omitted,
    ...(message !== undefined ? { message } : {}),
  });

  try {
    if (!(await stat(projectDir)).isDirectory())
      return result('failed', 'The project folder was not found.');
  } catch {
    return result('failed', 'The project folder was not found.');
  }
  await assertTargetSafe(projectDir, target);

  const state = await readExportState(stackHome);
  const stored = state.projects[projectId]?.[agent];
  const record = stored?.path === target ? stored : undefined;
  const existing = await readExisting(target);

  if (existing.kind === 'other' || (existing.kind === 'file' && !record))
    return result(
      'skipped-user-file',
      `${label} already exists and was not written by STAK; leaving it alone.`,
    );
  const handEdited =
    existing.kind === 'file' &&
    record !== undefined &&
    hashBytes(existing.bytes) !== record.sha256;
  if (handEdited && !options.overwriteHandEdits)
    return result(
      'skipped-hand-edited',
      `${label} was edited by hand. Move the edit into your real memory, or reset the file with \`stak memory agents reset ${agent}\`.`,
    );

  const privacy = await resolvePrivacy(git, projectDir, agent);
  if (privacy.kind === 'skip') return result(privacy.status, privacy.message);

  const team =
    agent === 'codex' ? await readTeamAgentsMd(projectDir) : undefined;
  const rendered = renderAgentMemory({
    agent,
    documents: options.documents,
    ...(team ? { teamAgentsMd: team.text } : {}),
  });
  if (rendered.status === 'team-agents-md-too-large') {
    // An old override would now hide the team's new AGENTS.md from Codex, so
    // withdraw STAK's own (unchanged) file.
    if (existing.kind === 'file' && record && !handEdited) {
      await rm(target, { force: true });
      if (record.exclude)
        await removeGitExcludeEntry(record.exclude.file, record.exclude.entry);
      await updateRecord(stackHome, projectId, agent, undefined);
    }
    return result(
      'skipped-team-too-large',
      'The team AGENTS.md alone is too large for Codex to also read STAK Memory; no override was written.',
    );
  }

  const bytes = Buffer.from(rendered.content, 'utf8');
  const sha256 = hashBytes(bytes);
  const exclude =
    privacy.kind === 'exclude'
      ? { file: privacy.file, entry: privacy.entry }
      : undefined;

  // Hide the file from Git before it exists.
  if (exclude) await addGitExcludeEntry(exclude.file, exclude.entry);
  if (record?.exclude && !sameExclude(record.exclude, exclude))
    await removeGitExcludeEntry(record.exclude.file, record.exclude.entry);

  const unchanged =
    existing.kind === 'file' && hashBytes(existing.bytes) === sha256;
  if (!unchanged) await atomicWriteFile(target, bytes);

  const agentsMdHash = team?.hash ?? null;
  const recordIsCurrent =
    unchanged &&
    record !== undefined &&
    record.sha256 === sha256 &&
    record.agentsMdHash === agentsMdHash &&
    sameExclude(record.exclude, exclude);
  if (!recordIsCurrent)
    await updateRecord(stackHome, projectId, agent, {
      path: target,
      sha256,
      agentsMdHash,
      ...(exclude ? { exclude } : {}),
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    });

  return result(
    unchanged ? 'unchanged' : 'written',
    undefined,
    rendered.omitted,
  );
};

/** Write (or refresh) one agent's Memory file for one project. Never throws. */
export const exportProjectMemory = async (
  options: ExportProjectMemoryOptions,
): Promise<ExportResult> => {
  const projectDir = path.resolve(options.projectDir);
  const target = agentExportTargetOf(projectDir, options.agent);
  try {
    return await exportOnce(options, projectDir, target);
  } catch (error) {
    return {
      status: 'failed',
      path: target,
      omitted: [],
      message: messageOf(error),
    };
  }
};

export type RemoveProjectExportOptions = {
  stackHome: string;
  projectId: string;
  projectDir: string;
  agent: AgentExportId;
};

/** Delete STAK's file for one project and agent, only if unchanged since STAK
 * wrote it, and drop its exclude line (and the block once empty). A hand-edited
 * file keeps its exclude line and record, so it stays private and reported. */
export const removeProjectExport = async (
  options: RemoveProjectExportOptions,
): Promise<{ status: 'removed' | 'kept-hand-edited' | 'none' }> => {
  const projectDir = path.resolve(options.projectDir);
  const target = agentExportTargetOf(projectDir, options.agent);
  const state = await readExportState(options.stackHome);
  const record = state.projects[options.projectId]?.[options.agent];
  if (!record || record.path !== target) return { status: 'none' };

  const existing = await readExisting(target);
  if (
    existing.kind === 'other' ||
    (existing.kind === 'file' && hashBytes(existing.bytes) !== record.sha256)
  )
    return { status: 'kept-hand-edited' };
  if (existing.kind === 'file') {
    await assertTargetSafe(projectDir, target);
    await rm(target, { force: true });
  }
  if (record.exclude)
    await removeGitExcludeEntry(record.exclude.file, record.exclude.entry);
  await updateRecord(
    options.stackHome,
    options.projectId,
    options.agent,
    undefined,
  );
  return { status: existing.kind === 'file' ? 'removed' : 'none' };
};

export type ExportStatusOptions = RemoveProjectExportOptions & {
  /** When given, `stale` also covers Memory that changed since the last write. */
  documents?: ReadonlyArray<AgentMemoryDocument>;
};

/** Read-only freshness of one agent's file for one project. */
export const exportStatus = async (
  options: ExportStatusOptions,
): Promise<
  'up-to-date' | 'stale' | 'hand-edited' | 'user-file' | 'missing'
> => {
  const projectDir = path.resolve(options.projectDir);
  const target = agentExportTargetOf(projectDir, options.agent);
  const existing = await readExisting(target);
  if (existing.kind === 'none') return 'missing';
  const state = await readExportState(options.stackHome);
  const stored = state.projects[options.projectId]?.[options.agent];
  if (existing.kind === 'other' || !stored || stored.path !== target)
    return 'user-file';
  if (hashBytes(existing.bytes) !== stored.sha256) return 'hand-edited';
  const team =
    options.agent === 'codex' ? await readTeamAgentsMd(projectDir) : undefined;
  if (options.agent === 'codex' && (team?.hash ?? null) !== stored.agentsMdHash)
    return 'stale';
  if (options.documents) {
    const rendered = renderAgentMemory({
      agent: options.agent,
      documents: options.documents,
      ...(team ? { teamAgentsMd: team.text } : {}),
    });
    if (
      rendered.status !== 'ok' ||
      hashBytes(Buffer.from(rendered.content, 'utf8')) !== stored.sha256
    )
      return 'stale';
  }
  return 'up-to-date';
};

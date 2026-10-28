/**
 * Cross-agent Project Memory exporter (spec 2026-10-28 §4–§8).
 *
 * Writes one project's rendered Memory into one agent's file inside the project
 * folder, keeps that file out of Git with the repo's local-only exclude list,
 * and records what it wrote in machine-local state so it only ever updates or
 * deletes its own, unchanged files.
 *
 * Privacy invariants (a STAK file must never become committable):
 *  - the exclude lines (the file and its atomic-write temp sibling) are added,
 *    and Git is asked to confirm they hold, BEFORE the file is written;
 *  - an exclude line is removed only when no record (current or retired) in
 *    the state still uses it — worktrees of one repo share one exclude file;
 *  - a file left behind by a moved project stays recorded ("retired"), and so
 *    stays excluded, until it is deleted (by STAK if unchanged, or the user).
 *
 * The exporter never takes the Memory lock: callers run it inside their own
 * locked span. `exportProjectMemory` never throws — every problem is a result.
 */
import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertPathWithin, PathFenceError } from '@stack/shared';
import { z } from 'zod';

import { assertRootHasNoSymlinkSegments } from '../canonical/claude-project-adapter.js';
import { atomicTempPath, atomicWriteFile } from '../remote/secure-file.js';
import { hashBytes, memoryStorePaths } from '../store.js';
import {
  addGitExcludeEntries,
  defaultGitRunner,
  excludeEntryFor,
  isIgnoredByGit,
  isTrackedByGit,
  locateGitRepository,
  readGitExcludeEntries,
  removeGitExcludeEntries,
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

export const agentExportTargetOf = (
  projectDir: string,
  agent: AgentExportId,
): string =>
  path.join(projectDir, ...AGENT_EXPORT_RELATIVE_PATHS[agent].split('/'));

/** The project folder a recorded target belongs to (the inverse of
 * `agentExportTargetOf`). */
const projectDirOfTarget = (target: string, agent: AgentExportId): string =>
  path.resolve(
    target,
    ...AGENT_EXPORT_RELATIVE_PATHS[agent].split('/').map(() => '..'),
  );

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

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const exportRecordSchema = z.object({
  /** Absolute path of the file STAK wrote. */
  path: z.string().min(1),
  /** `sha256:<hex>` of the exact bytes STAK last wrote. */
  sha256: sha256Schema,
  /** Codex: hash of the team `AGENTS.md` bytes it was built from (null when
   * there was none). Always null for Cursor. */
  agentsMdHash: sha256Schema.nullable(),
  /** The exclude lines STAK relies on for this file (the file itself and its
   * temp sibling), so they can be released without asking Git. `file` is the
   * real path of the exclude file. */
  exclude: z
    .object({
      file: z.string().min(1),
      entries: z.array(z.string().min(1)).min(1),
    })
    .optional(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AgentExportRecord = z.infer<typeof exportRecordSchema>;

const retiredRecordSchema = exportRecordSchema.extend({
  projectId: z.string().min(1),
  agent: z.enum(AGENT_EXPORT_IDS),
});
export type RetiredAgentExportRecord = z.infer<typeof retiredRecordSchema>;

const privateFileRecordSchema = z.object({
  /** Absolute path of the private file. */
  path: z.string().min(1),
  exclude: z.object({
    file: z.string().min(1),
    entries: z.array(z.string().min(1)).min(1),
  }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type PrivateFileRecord = z.infer<typeof privateFileRecordSchema>;

const exportStateSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({
      codex: exportRecordSchema.optional(),
      cursor: exportRecordSchema.optional(),
    }),
  ),
  /** Files STAK wrote at a project's previous location that could not be
   * deleted yet (hand-edited). Kept so their exclude lines stay in place. */
  retired: z.array(retiredRecordSchema).optional(),
  /** Private agent files materialize writes into a project folder (Claude's
   * `CLAUDE.local.md`) that STAK keeps out of Git: the exclude lines each one
   * relies on, so they are released only when no record uses them. */
  privateFiles: z.array(privateFileRecordSchema).optional(),
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

/** Read, change and write the state; returns what was written. */
const mutateState = async (
  stackHome: string,
  change: (state: AgentExportState) => AgentExportState,
): Promise<AgentExportState> => {
  const next = exportStateSchema.parse(
    change(await readExportState(stackHome)),
  );
  await writeJson(agentExportPaths(stackHome).state, next);
  return next;
};

const withRecord = (
  state: AgentExportState,
  projectId: string,
  agent: AgentExportId,
  record: AgentExportRecord | undefined,
): AgentExportState => {
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
  return { ...state, projects };
};

const comparableFile = (file: string): string => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Record paths are compared like this everywhere, so `C:\` vs `c:\` on
 * Windows is never mistaken for a moved project. */
const samePath = (a: string, b: string): boolean =>
  comparableFile(a) === comparableFile(b);

const sameRetired = (
  a: RetiredAgentExportRecord,
  b: RetiredAgentExportRecord,
): boolean =>
  a.projectId === b.projectId &&
  a.agent === b.agent &&
  samePath(a.path, b.path);

const TEMP_SIBLING =
  /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/** Delete STAK's own leftover temp siblings of `target` (`.<name>.<uuid>.tmp`,
 * left by a crash mid-write). Returns false when one could not be removed. */
const removeTempSiblings = async (target: string): Promise<boolean> => {
  const name = path.basename(target);
  let entries: string[];
  try {
    entries = await readdir(path.dirname(target));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let clean = true;
  for (const entry of entries) {
    if (TEMP_SIBLING.exec(entry)?.[1] !== name) continue;
    const sibling = path.join(path.dirname(target), entry);
    try {
      if ((await lstat(sibling)).isFile()) await rm(sibling, { force: true });
      else clean = false;
    } catch {
      clean = false;
    }
  }
  return clean;
};

/** Remove the exclude lines of `exclude` that no record in `state` (current,
 * retired or private-file) still uses. Call AFTER the state no longer holds
 * the released record, so a line shared with another worktree's record
 * survives. `target` is the file the lines were for: before its temp-pattern
 * line goes, STAK's crashed temp siblings are deleted (if one can't be, the
 * line stays, so it can never be committed). */
const releaseExclude = async (
  state: AgentExportState,
  exclude: AgentExportRecord['exclude'],
  target?: string,
): Promise<void> => {
  if (!exclude) return;
  const file = comparableFile(exclude.file);
  const records: Array<Pick<AgentExportRecord, 'exclude'>> = [
    ...Object.values(state.projects).flatMap((project) =>
      AGENT_EXPORT_IDS.flatMap((id) => (project[id] ? [project[id]] : [])),
    ),
    ...(state.retired ?? []),
    ...(state.privateFiles ?? []),
  ];
  const stillUsed = new Set(
    records.flatMap((record) =>
      record.exclude && comparableFile(record.exclude.file) === file
        ? record.exclude.entries
        : [],
    ),
  );
  let unused = exclude.entries.filter((entry) => !stillUsed.has(entry));
  if (unused.some((entry) => entry.endsWith('.*.tmp'))) {
    const clean = target !== undefined && (await removeTempSiblings(target));
    if (!clean) unused = unused.filter((entry) => !entry.endsWith('.*.tmp'));
  }
  if (unused.length > 0) await removeGitExcludeEntries(exclude.file, unused);
};

/** Drop the current record for (project, agent), then release its lines. */
const dropRecord = async (
  stackHome: string,
  projectId: string,
  agent: AgentExportId,
  extra?: { exclude: AgentExportRecord['exclude']; target: string },
): Promise<void> => {
  const before = (await readExportState(stackHome)).projects[projectId]?.[
    agent
  ];
  const next = await mutateState(stackHome, (state) =>
    withRecord(state, projectId, agent, undefined),
  );
  await releaseExclude(next, before?.exclude, before?.path);
  if (extra) await releaseExclude(next, extra.exclude, extra.target);
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

/** The nearest folder at or above `dir` with a `.git` entry (file or folder). */
const gitAncestorOf = async (dir: string): Promise<string | undefined> => {
  let current = dir;
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

/** Whether `dir` or any ancestor has a `.git` entry (file or folder). */
const hasGitAncestor = async (dir: string): Promise<boolean> =>
  (await gitAncestorOf(dir)) !== undefined;

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

const toPosix = (relative: string): string =>
  relative.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Moved projects

/** A recorded file at a location other than `target` belongs to the project's
 * previous folder: move its record to `retired`. */
const retireIfMoved = async (
  stackHome: string,
  projectId: string,
  agent: AgentExportId,
  target: string,
): Promise<void> => {
  const state = await readExportState(stackHome);
  const stored = state.projects[projectId]?.[agent];
  const isHere = (record: RetiredAgentExportRecord) =>
    record.projectId === projectId &&
    record.agent === agent &&
    samePath(record.path, target);
  const returning = (state.retired ?? []).find(isHere);
  if ((stored && samePath(stored.path, target)) || (!stored && !returning))
    return;
  await mutateState(stackHome, (current) => {
    const retired = [
      ...(current.retired ?? []).filter((record) => !isHere(record)),
      ...(stored ? [{ ...stored, projectId, agent }] : []),
    ];
    // Moving back to a folder STAK wrote before: its retired record becomes
    // current again, so a hand edit there reads as hand-edited (and `reset`
    // works) instead of as the user's own file.
    // (Parsing with the record schema strips `projectId` and `agent`.)
    const restored = returning
      ? exportRecordSchema.parse(returning)
      : undefined;
    return { ...withRecord(current, projectId, agent, restored), retired };
  });
};

/** Delete retired files for (project, agent) that are unchanged or already
 * gone, and release their exclude lines. Hand-edited ones stay recorded (and
 * excluded). Returns how many are still kept. */
const sweepRetired = async (
  stackHome: string,
  projectId: string,
  agent: AgentExportId,
): Promise<number> => {
  const candidates = ((await readExportState(stackHome)).retired ?? []).filter(
    (record) => record.projectId === projectId && record.agent === agent,
  );
  let kept = 0;
  for (const record of candidates) {
    try {
      const existing = await readExisting(record.path);
      if (existing.kind === 'other') {
        kept += 1;
        continue;
      }
      if (existing.kind === 'file') {
        if (hashBytes(existing.bytes) !== record.sha256) {
          kept += 1;
          continue;
        }
        await assertTargetSafe(
          projectDirOfTarget(record.path, agent),
          record.path,
        );
        await rm(record.path, { force: true });
      }
      const next = await mutateState(stackHome, (state) => ({
        ...state,
        retired: (state.retired ?? []).filter(
          (other) => !sameRetired(other, record),
        ),
      }));
      await releaseExclude(next, record.exclude, record.path);
    } catch {
      kept += 1; // unreadable or unsafe: keep it recorded, and so excluded
    }
  }
  return kept;
};

// ---------------------------------------------------------------------------
// Export

export type ExportStatusCode =
  | 'written'
  | 'unchanged'
  | 'skipped-user-file'
  | 'skipped-hand-edited'
  | 'skipped-tracked'
  | 'skipped-not-ignorable'
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
  | { kind: 'exclude'; file: string; entries: string[] }
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
      message: `${relative} is tracked by Git; STAK will not write a file that could be committed.`,
    };
  return {
    kind: 'exclude',
    file: location.excludePath,
    entries: await anchoredExcludeEntries(
      location.toplevel,
      projectDir,
      relative,
    ),
  };
};

/** The root-anchored exclude lines for `relative` (POSIX, inside
 * `projectDir`): the file itself and the temp sibling `atomicWriteFile`
 * writes first (`.<name>.<uuid>.tmp`). Paths are taken from the worktree
 * root, with realpath on both sides. */
const anchoredExcludeEntries = async (
  toplevel: string,
  projectDir: string,
  relative: string,
): Promise<string[]> => {
  const fromRoot = path.relative(
    await realpath(toplevel),
    await realpath(projectDir),
  );
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error('The project folder is outside its Git working tree.');
  const segments = [
    ...fromRoot.split(path.sep).filter((segment) => segment.length > 0),
    ...relative.split('/'),
  ];
  const name = segments.pop() ?? relative;
  const folder = segments.map((segment) => `${segment}/`).join('');
  return [
    excludeEntryFor(`${folder}${name}`),
    `${excludeEntryFor(`${folder}.${name}`)}.*.tmp`,
  ];
};

const sameExclude = (
  a: AgentExportRecord['exclude'],
  b: AgentExportRecord['exclude'],
): boolean =>
  a?.file === b?.file && a?.entries.join('\n') === b?.entries.join('\n');

const exportOnce = async (
  options: ExportProjectMemoryOptions,
  projectDir: string,
  target: string,
): Promise<ExportResult> => {
  const { stackHome, projectId, agent } = options;
  const git = options.git ?? defaultGitRunner;
  const label = AGENT_EXPORT_RELATIVE_PATHS[agent];
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

  await retireIfMoved(stackHome, projectId, agent, target);
  await sweepRetired(stackHome, projectId, agent);

  const state = await readExportState(stackHome);
  const record = state.projects[projectId]?.[agent];
  const existing = await readExisting(target);
  if (existing.kind === 'other')
    return result(
      'skipped-user-file',
      `${label} already exists and was not written by STAK; leaving it alone.`,
    );

  const team =
    agent === 'codex' ? await readTeamAgentsMd(projectDir) : undefined;
  const rendered = renderAgentMemory({
    agent,
    documents: options.documents,
    ...(team ? { teamAgentsMd: team.text } : {}),
  });
  const bytes =
    rendered.status === 'ok' ? Buffer.from(rendered.content, 'utf8') : null;
  const sha256 = bytes ? hashBytes(bytes) : null;
  const existingSha =
    existing.kind === 'file' ? hashBytes(existing.bytes) : null;

  // A file with no record is the user's — unless it is byte-for-byte what STAK
  // would write now (a crash between writing it and recording it): adopt it.
  if (existingSha !== null && !record && existingSha !== sha256)
    return result(
      'skipped-user-file',
      `${label} already exists and was not written by STAK; leaving it alone.`,
    );
  const handEdited =
    existingSha !== null &&
    record !== undefined &&
    existingSha !== record.sha256;
  if (handEdited && !options.overwriteHandEdits)
    return result(
      'skipped-hand-edited',
      `${label} was edited by hand. Move the edit into your real memory, or reset the file with \`stak memory agents reset ${agent}\`.`,
    );
  // STAK's own file, unchanged since it wrote it (or identical to a fresh one).
  const ownUnchanged = existingSha !== null && !handEdited;

  const privacy = await resolvePrivacy(git, projectDir, agent);
  if (privacy.kind === 'skip') return result(privacy.status, privacy.message);

  if (!bytes || !sha256) {
    // An old override would now hide the team's new AGENTS.md from Codex, so
    // withdraw STAK's own (unchanged) file.
    if (ownUnchanged && record) {
      await rm(target, { force: true });
      await dropRecord(stackHome, projectId, agent);
    }
    return result(
      'skipped-team-too-large',
      'The team AGENTS.md alone is too large for Codex to also read STAK Memory; no override was written.',
    );
  }

  let exclude: AgentExportRecord['exclude'];
  if (privacy.kind === 'exclude') {
    // Hide the file (and its temp sibling) from Git before either exists, and
    // confirm with Git that nothing (a `.gitignore` negation) re-includes them.
    await addGitExcludeEntries(privacy.file, privacy.entries);
    exclude = { file: await realpath(privacy.file), entries: privacy.entries };
    const probes = [
      label,
      toPosix(path.relative(projectDir, atomicTempPath(target))),
    ];
    let ignorable = true;
    for (const probe of probes)
      if (!(await isIgnoredByGit(git, projectDir, probe))) ignorable = false;
    if (!ignorable) {
      // A STAK file there would be committable: withdraw it if it is ours and
      // unchanged. A hand-edited one (reached only on reset) stays recorded.
      if (!handEdited) {
        if (ownUnchanged) await rm(target, { force: true });
        await dropRecord(stackHome, projectId, agent, { exclude, target });
      }
      return result(
        'skipped-not-ignorable',
        `This repository's .gitignore re-includes ${label} (a "!" rule), so STAK cannot keep it out of Git and did not write it.`,
      );
    }
  }

  const unchanged = existingSha === sha256;
  if (!unchanged) await atomicWriteFile(target, bytes);

  const agentsMdHash = team?.hash ?? null;
  const recordIsCurrent =
    unchanged &&
    record !== undefined &&
    record.sha256 === sha256 &&
    record.agentsMdHash === agentsMdHash &&
    sameExclude(record.exclude, exclude);
  if (!recordIsCurrent) {
    const next = await mutateState(stackHome, (current) =>
      withRecord(current, projectId, agent, {
        path: target,
        sha256,
        agentsMdHash,
        ...(exclude ? { exclude } : {}),
        updatedAt: (options.now?.() ?? new Date()).toISOString(),
      }),
    );
    // Lines of a previous exclude location that nothing uses any more.
    if (record?.exclude && !sameExclude(record.exclude, exclude))
      await releaseExclude(next, record.exclude, record.path);
  }

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
 * wrote it, and release its exclude lines (the block goes once empty). Files
 * left at a previous project folder are cleaned the same way. A hand-edited
 * file keeps its record and exclude lines, so it stays private and reported. */
export const removeProjectExport = async (
  options: RemoveProjectExportOptions,
): Promise<{ status: 'removed' | 'kept-hand-edited' | 'none' }> => {
  const { stackHome, projectId, agent } = options;
  const projectDir = path.resolve(options.projectDir);
  const target = agentExportTargetOf(projectDir, agent);
  await retireIfMoved(stackHome, projectId, agent, target);
  const keptRetired = await sweepRetired(stackHome, projectId, agent);
  const fallback = keptRetired > 0 ? 'kept-hand-edited' : 'none';

  const record = (await readExportState(stackHome)).projects[projectId]?.[
    agent
  ];
  if (!record) return { status: fallback };

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
  await dropRecord(stackHome, projectId, agent);
  return {
    status:
      keptRetired > 0
        ? 'kept-hand-edited'
        : existing.kind === 'file'
          ? 'removed'
          : 'none',
  };
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
  if (existing.kind === 'other' || !stored || !samePath(stored.path, target))
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

// ---------------------------------------------------------------------------
// Private agent files written by materialize (Claude's CLAUDE.local.md)

export type PrivateFileGuardResult =
  | {
      /** Write it. `excluded`: STAK's exclude lines keep it out of Git;
       * `ignored`: the repository already ignores it; `tracked`: the user
       * commits it on purpose; `plain`: not a Git repository. */
      write: true;
      status: 'excluded' | 'ignored' | 'tracked' | 'plain';
    }
  | {
      write: false;
      status: 'skipped-not-ignorable' | 'skipped-no-git' | 'failed';
      message: string;
    };

export type PrivateFileGuardOptions = {
  stackHome: string;
  projectDir: string;
  /** POSIX path inside `projectDir`, for example `CLAUDE.local.md`. */
  relativePath: string;
  git?: GitRunner;
  now?: () => Date;
};

/**
 * Call right BEFORE materialize writes a private file into a project folder,
 * inside the caller's Memory lock. Applies the agent files' privacy rules to
 * it: in a Git repository a file that is not tracked and not already ignored
 * gets STAK's root-anchored exclude lines (the file and its temp sibling), and
 * Git must then confirm it is ignored. Fails closed: a `.gitignore` negation,
 * an unusable Git or any error means "don't write". A tracked file is the
 * user's to commit and is written as before. Never throws.
 */
export const guardPrivateProjectFile = async (
  options: PrivateFileGuardOptions,
): Promise<PrivateFileGuardResult> => {
  const { stackHome, relativePath } = options;
  const git = options.git ?? defaultGitRunner;
  const projectDir = path.resolve(options.projectDir);
  const target = path.join(projectDir, ...relativePath.split('/'));
  const notWritten = (reason: string) =>
    `${relativePath} was not written: ${reason}`;
  try {
    const location = await locateGitRepository(git, projectDir);
    if (location.kind !== 'repo') {
      const repo = await gitAncestorOf(projectDir);
      if (repo === undefined) return { write: true, status: 'plain' };
      return {
        write: false,
        status: 'skipped-no-git',
        message: notWritten(
          location.kind === 'no-git'
            ? "Git isn't installed or can't be started, so STAK can't keep your private instructions out of this repository."
            : `Git refused to read this repository (for example its safe.directory ownership check), so STAK can't keep your private instructions out of it. If you trust it, run \`git config --global --add safe.directory ${repo}\`.`,
        ),
      };
    }
    if (await isTrackedByGit(git, projectDir, relativePath))
      return { write: true, status: 'tracked' };

    const entries = await anchoredExcludeEntries(
      location.toplevel,
      projectDir,
      relativePath,
    );
    const probes = [
      relativePath,
      toPosix(path.relative(projectDir, atomicTempPath(target))),
    ];
    const ignored: boolean[] = [];
    for (const probe of probes)
      ignored.push(await isIgnoredByGit(git, projectDir, probe));
    // A line already in STAK's block (another worktree's copy shares this
    // exclude file) is relied on too, so it is recorded here as well and is
    // never released while this copy still needs it.
    const inBlock = new Set(await readGitExcludeEntries(location.excludePath));
    const needed = entries.filter(
      (entry, index) => !ignored[index] || inBlock.has(entry),
    );
    if (needed.length === 0) return { write: true, status: 'ignored' };

    const state = await readExportState(stackHome);
    const prior = (state.privateFiles ?? []).find((record) =>
      samePath(record.path, target),
    );
    await addGitExcludeEntries(location.excludePath, needed);
    const file = await realpath(location.excludePath);
    let ignorable = true;
    for (const probe of probes)
      if (!(await isIgnoredByGit(git, projectDir, probe))) ignorable = false;
    if (!ignorable) {
      // A "!" rule wins over the exclude: release what this call added (a line
      // another record relies on stays), and don't write.
      await releaseExclude(
        state,
        {
          file,
          entries: needed.filter(
            (entry) => !(prior?.exclude.entries ?? []).includes(entry),
          ),
        },
        target,
      );
      return {
        write: false,
        status: 'skipped-not-ignorable',
        message: notWritten(
          `this repository's .gitignore re-includes it (a "!" rule), so STAK can't keep your private instructions out of Git.`,
        ),
      };
    }
    await mutateState(stackHome, (current) => ({
      ...current,
      privateFiles: [
        ...(current.privateFiles ?? []).filter(
          (record) => !samePath(record.path, target),
        ),
        {
          path: target,
          exclude: {
            file,
            entries: [
              ...new Set([...(prior?.exclude.entries ?? []), ...needed]),
            ],
          },
          updatedAt: (options.now?.() ?? new Date()).toISOString(),
        },
      ],
    }));
    return { write: true, status: 'excluded' };
  } catch (error) {
    if (error instanceof AgentExportStateError)
      return {
        write: false,
        status: 'failed',
        message: notWritten(
          `STAK's record of the files it keeps out of Git (${agentExportPaths(stackHome).state}) is unreadable. Move it aside (e.g. state.json.bak), then run \`stak pull\` (or \`stak memory materialize\`).`,
        ),
      };
    return {
      write: false,
      status: 'failed',
      message: notWritten(
        `${messageOf(error)} STAK can't confirm it would stay out of Git.`,
      ),
    };
  }
};

/** Call after materialize deleted a private file: drop its record and release
 * the exclude lines no other record uses. A no-op when there is no record. */
export const releasePrivateProjectFile = async (options: {
  stackHome: string;
  projectDir: string;
  relativePath: string;
}): Promise<void> => {
  const target = path.join(
    path.resolve(options.projectDir),
    ...options.relativePath.split('/'),
  );
  const record = (
    (await readExportState(options.stackHome)).privateFiles ?? []
  ).find((r) => samePath(r.path, target));
  if (!record) return;
  const next = await mutateState(options.stackHome, (state) => ({
    ...state,
    privateFiles: (state.privateFiles ?? []).filter(
      (r) => !samePath(r.path, target),
    ),
  }));
  await releaseExclude(next, record.exclude, record.path);
};

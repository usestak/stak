/**
 * Git helpers for cross-agent Project Memory (spec 2026-10-28 §5): find the
 * repository a project lives in, keep STAK's files in the repo's local-only
 * exclude list (`git rev-parse --git-path info/exclude`) inside a marked block,
 * and refuse files Git already tracks.
 *
 * Every `git` call goes through an injectable `GitRunner`, so tests can use a
 * real temporary repository or a fake.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '../remote/secure-file.js';

export type GitRunResult = { exitCode: number; stdout: string; stderr: string };

/** Runs `git -C <cwd> <args…>`. Resolves with the exit code for any completed
 * run (zero or not); rejects with `GitUnavailableError` when `git` cannot be
 * started at all. */
export interface GitRunner {
  run(cwd: string, args: readonly string[]): Promise<GitRunResult>;
}

export class GitUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Git is not available on this machine.', options);
    this.name = 'GitUnavailableError';
  }
}

export class GitExcludeError extends Error {
  constructor(
    public readonly code: 'malformed-block' | 'git-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitExcludeError';
  }
}

export const defaultGitRunner: GitRunner = {
  run: (cwd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const out = String(stdout);
          const err = String(stderr);
          if (!error) {
            resolve({ exitCode: 0, stdout: out, stderr: err });
            return;
          }
          // `code` is the exit status for a run that completed, or a string
          // such as 'ENOENT' when git could not be started.
          const code: unknown = error.code;
          if (typeof code === 'number') {
            resolve({ exitCode: code, stdout: out, stderr: err });
            return;
          }
          if (code === 'ENOENT') {
            reject(new GitUnavailableError({ cause: error }));
            return;
          }
          reject(error);
        },
      );
    }),
};

export const STAK_EXCLUDE_BEGIN = '# >>> STAK (managed) >>>';
export const STAK_EXCLUDE_END = '# <<< STAK <<<';

/** A root-anchored exclude entry for a path relative to the worktree root
 * (forward slashes). Pattern characters are escaped so the entry matches only
 * that one file. */
export const excludeEntryFor = (relativePosixPath: string): string => {
  const escaped = relativePosixPath
    .replace(/[\\*?[\]]/g, (character) => `\\${character}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
  return `/${escaped}`;
};

type Lines = { lines: string[]; begin: number; end: number };

const parseBlock = (text: string): Lines => {
  const lines = text.length === 0 ? [] : text.split('\n');
  // A trailing newline yields one empty last element; keep it so joining
  // restores the original bytes exactly.
  const bare = (line: string) => line.replace(/\r$/, '');
  const begins = lines.flatMap((line, index) =>
    bare(line) === STAK_EXCLUDE_BEGIN ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    bare(line) === STAK_EXCLUDE_END ? [index] : [],
  );
  if (begins.length === 0 && ends.length === 0)
    return { lines, begin: -1, end: -1 };
  const [begin] = begins;
  const [end] = ends;
  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    begin === undefined ||
    end === undefined ||
    end < begin
  )
    throw new GitExcludeError(
      'malformed-block',
      'The STAK block in the Git exclude file is damaged. Remove the lines between the STAK markers and try again.',
    );
  return { lines, begin, end };
};

const entriesOf = ({ lines, begin, end }: Lines): string[] =>
  lines
    .slice(begin + 1, end)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);

/** `text` with `entry` inside STAK's block (created at the end if absent).
 * Idempotent; lines outside the block are never changed. */
export const withExcludeEntry = (text: string, entry: string): string => {
  const parsed = parseBlock(text);
  if (parsed.begin === -1) {
    const lead = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return `${text}${lead}${STAK_EXCLUDE_BEGIN}\n${entry}\n${STAK_EXCLUDE_END}\n`;
  }
  const entries = entriesOf(parsed);
  if (entries.includes(entry)) return text;
  const next = [...entries, entry].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { lines, begin, end } = parsed;
  return [...lines.slice(0, begin + 1), ...next, ...lines.slice(end)].join(
    '\n',
  );
};

/** `text` without `entry`; the block is removed entirely once it is empty.
 * Lines outside the block are never changed. */
export const withoutExcludeEntry = (text: string, entry: string): string => {
  const parsed = parseBlock(text);
  if (parsed.begin === -1) return text;
  const entries = entriesOf(parsed);
  if (!entries.includes(entry)) return text;
  const next = entries.filter((existing) => existing !== entry);
  const { lines, begin, end } = parsed;
  if (next.length > 0)
    return [...lines.slice(0, begin + 1), ...next, ...lines.slice(end)].join(
      '\n',
    );
  // Drop the block's own lines, including the end marker's line break.
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n');
};

const readTextOrEmpty = async (file: string): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
};

const existingMode = async (file: string): Promise<number> => {
  try {
    return (await lstat(file)).mode & 0o777;
  } catch {
    return 0o644;
  }
};

const rewrite = async (
  file: string,
  update: (text: string) => string,
): Promise<void> => {
  const before = await readTextOrEmpty(file);
  const after = update(before);
  if (after === before) return;
  // Creates `info/` when it is missing. Keeps the file's own permissions: the
  // exclude list holds no Memory content.
  await atomicWriteFile(file, Buffer.from(after, 'utf8'), {
    mode: await existingMode(file),
  });
};

/** The entries inside STAK's block of `excludePath` (empty when the file or
 * the block is absent). Throws `GitExcludeError('malformed-block')`. */
export const readGitExcludeEntries = async (
  excludePath: string,
): Promise<string[]> => {
  const parsed = parseBlock(await readTextOrEmpty(excludePath));
  return parsed.begin === -1 ? [] : entriesOf(parsed);
};

export const addGitExcludeEntries = (
  excludePath: string,
  entries: readonly string[],
): Promise<void> =>
  rewrite(excludePath, (text) =>
    entries.reduce((next, entry) => withExcludeEntry(next, entry), text),
  );

export const removeGitExcludeEntries = (
  excludePath: string,
  entries: readonly string[],
): Promise<void> =>
  rewrite(excludePath, (text) =>
    entries.reduce((next, entry) => withoutExcludeEntry(next, entry), text),
  );

export const addGitExcludeEntry = (
  excludePath: string,
  entry: string,
): Promise<void> => addGitExcludeEntries(excludePath, [entry]);

export const removeGitExcludeEntry = (
  excludePath: string,
  entry: string,
): Promise<void> => removeGitExcludeEntries(excludePath, [entry]);

/** `git rev-parse --git-path info/exclude`, resolved against `dir` (Git prints
 * a path relative to `-C <dir>` for a plain repo, an absolute one for a
 * worktree or submodule). */
export const resolveGitExcludePath = async (
  git: GitRunner,
  dir: string,
): Promise<string> => {
  const result = await git.run(dir, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ]);
  const printed = result.stdout.trim();
  if (result.exitCode !== 0 || printed.length === 0)
    throw new GitExcludeError(
      'git-failed',
      'Git could not report the exclude file location.',
    );
  return path.resolve(dir, printed);
};

export type GitLocation =
  | { kind: 'repo'; toplevel: string; excludePath: string }
  | { kind: 'not-repo' }
  | { kind: 'no-git' };

/** Where `dir` sits relative to Git. `not-repo` is Git's own answer and can
 * also mean Git refused the folder (for example `safe.directory`); callers must
 * still check for a `.git` entry before treating the folder as unversioned. */
export const locateGitRepository = async (
  git: GitRunner,
  dir: string,
): Promise<GitLocation> => {
  let result: GitRunResult;
  try {
    result = await git.run(dir, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (error instanceof GitUnavailableError) return { kind: 'no-git' };
    throw error;
  }
  const toplevel = result.stdout.trim();
  if (result.exitCode !== 0 || toplevel.length === 0)
    return { kind: 'not-repo' };
  return {
    kind: 'repo',
    toplevel: path.resolve(toplevel),
    excludePath: await resolveGitExcludePath(git, dir),
  };
};

/** A yes/no Git query: exit 0 is yes, exit 1 is no, anything else is an error
 * (fail closed — never read an error as the answer that allows a write). */
const yesNo = async (
  git: GitRunner,
  dir: string,
  args: readonly string[],
  what: string,
): Promise<boolean> => {
  const result = await git.run(dir, args);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitExcludeError(
    'git-failed',
    `Git could not check whether ${what} (exit ${result.exitCode}).`,
  );
};

/** Whether Git tracks `relativePath` (relative to `dir`). */
export const isTrackedByGit = (
  git: GitRunner,
  dir: string,
  relativePath: string,
): Promise<boolean> =>
  yesNo(
    git,
    dir,
    ['ls-files', '--error-unmatch', '--', relativePath],
    `${relativePath} is tracked`,
  );

/** Whether Git's ignore rules (any `.gitignore`, `info/exclude`, the global
 * excludes file) ignore `relativePath` (relative to `dir`), regardless of the
 * index. */
export const isIgnoredByGit = (
  git: GitRunner,
  dir: string,
  relativePath: string,
): Promise<boolean> =>
  yesNo(
    git,
    dir,
    ['check-ignore', '-q', '--no-index', '--', relativePath],
    `${relativePath} is ignored`,
  );

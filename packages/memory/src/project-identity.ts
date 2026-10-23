import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { GitProjectIdentity, ProjectIdentity } from './domain.js';

/**
 * Canonicalize a Git remote URL into a portable, credential-free identity so the
 * same project is recognized across machines and moved directories. Handles
 * https/ssh/scp forms, embedded credentials, trailing `.git`, and host casing.
 * Returns null when no portable identity can be derived.
 */
export const canonicalGitIdentity = (
  remote: string | undefined | null,
): GitProjectIdentity | null => {
  if (!remote) return null;
  const rest = remote.trim();
  if (!rest) return null;

  let rawHost: string;
  let rawPath: string;

  const scpMatch = rest.match(/^([^@/]+@)?([^:/]+):(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    // URL form: scheme://[user[:pass]@]host[:port]/path
    let url: URL;
    try {
      url = new URL(rest);
    } catch {
      return null;
    }
    rawHost = url.hostname.toLowerCase();
    rawPath = url.pathname;
  } else if (scpMatch && scpMatch[2] && scpMatch[3]) {
    // scp form: [user@]host:owner/repo
    rawHost = scpMatch[2].toLowerCase();
    rawPath = scpMatch[3];
  } else {
    return null;
  }

  // Strip credentials that may survive scp userinfo (never keep secrets).
  const host = rawHost.replace(/^[^@]*@/, '');
  const segments = rawPath
    .replace(/\\/g, '/')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (!host || segments.length < 2) return null;
  const repo = segments[segments.length - 1] ?? '';
  const owner = segments.slice(0, -1).join('/');
  if (!owner || !repo) return null;
  return {
    kind: 'git',
    host,
    owner,
    repo,
    canonical: `${host}/${owner}/${repo}`,
  };
};

/**
 * Encode an absolute project path the way Claude Code keys its per-project
 * directory under `~/.claude/projects/`: every character that is not
 * `[a-zA-Z0-9]` becomes `-` — not just the drive/path separators (`:`, `\`, `/`),
 * but also `.`, `_`, spaces, and any other punctuation in a path segment's name
 * (observed on a real machine: `C:\Users\NT\.claude-mem` encodes to
 * `C--Users-NT--claude-mem`). Deterministic forward-only; used to match a known
 * local project to its auto-memory directory. The result is a machine-local
 * vendor key, never a portable identity.
 */
export const encodeClaudeProjectKey = (absolutePath: string): string =>
  absolutePath.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Normalize a Claude vendor key for MATCHING against a known local project.
 * On case-insensitive filesystems (Windows) the whole key is lowercased so a
 * drive-letter or path-component casing difference — e.g. Claude's
 * `c--Users-NT-Desktop-atlas-access-flow` vs a native `C:\Users\NT\Desktop\...`
 * — still matches. On POSIX (case-sensitive) the key is compared verbatim.
 * This only affects matching; the original vendor key is preserved as-is.
 */
export const normalizeVendorKey = (
  key: string,
  platform: NodeJS.Platform = process.platform,
): string => (platform === 'win32' ? key.toLowerCase() : key);

/** Stable key for grouping/logical-id purposes. */
export const projectIdentityKey = (identity: ProjectIdentity): string =>
  identity.kind === 'git'
    ? identity.canonical
    : `local:${identity.vendorKey ?? 'unresolved'}`;

/** List the real (non-symlink) child directory NAMES of `dir`, or `[]` on any
 * error (including "doesn't exist") — fail closed, never throw. Uses `readdir`'s
 * own `Dirent.isDirectory()`, which reports a symlink entry's OWN type (never what
 * it points to), consistent with how discovery itself treats symlinked entries
 * (see `claude-project-adapter.ts`'s `isDirNoSymlink`/`listDirNames` convention). */
const defaultListChildDirNames = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** Real `stat`-based directory check — used ONLY for `reconstructProjectDirs`'s
 * degenerate zero-token case (the vendor key IS the root itself, e.g. `C--`), where
 * there is no recursive readdir step to drive at all. */
const defaultIsDirectory = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Enumerate EVERY existing absolute directory that a Claude auto-memory vendor key
 * could decode to, by walking the REAL directory tree level by level rather than
 * guessing separator characters: at each level, list the current directory's real
 * children, and for each child whose OWN `encodeClaudeProjectKey`-encoded name is a
 * prefix of the remaining key (followed by `-`, or exactly the remainder at the very
 * end), recurse into it with whatever key remains. Because this compares against
 * each child's ACTUAL encoded name rather than enumerating candidate separator
 * choices, it handles ANY punctuation or Unicode in a real directory name (a dot, an
 * underscore, a space, parentheses, accented characters, ...) with no combinatorial
 * cost and no cap — `encodeClaudeProjectKey` is still lossy (multiple real
 * directories can decode to the same key), so this returns every distinct match;
 * the raw material for a SAFE, unique-only resolution (see `reconstructProjectDir`).
 * On readdir-budget overflow it returns `[]` (fail closed) rather than a
 * partial/biased set.
 */
export const reconstructProjectDirs = async (options: {
  vendorKey: string;
  /** Real `stat`-based existence check, used ONLY for the degenerate zero-token
   * (vendor key IS the root) case. Defaults to a real filesystem check; inject for
   * deterministic tests of that one edge case. */
  isDirectory?: (candidate: string) => Promise<boolean>;
  /** List a directory's real (non-symlink) child directory NAMES — the walk's one
   * dependency. Defaults to a real `readdir`; inject a synthetic one for
   * deterministic tests of a fake directory tree. */
  listDirs?: (dir: string) => Promise<string[]>;
  platform?: NodeJS.Platform;
  /** Max number of `listDirs` (readdir) CALLS across the whole walk — not a
   * per-candidate-string probe count like before: this algorithm never enumerates
   * candidate strings, so even a long, ambiguous real tree costs at most one call
   * per directory level actually visited. Exists purely as a defensive guard
   * against a pathological tree, essentially never reached by a realistic path. */
  maxProbes?: number;
}): Promise<string[]> => {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const listDirs = options.listDirs ?? defaultListChildDirNames;
  let root: string;
  let rest: string;
  if (platform === 'win32') {
    const match = /^([A-Za-z])--(.*)$/.exec(options.vendorKey);
    if (!match) return [];
    root = `${match[1]}:\\`;
    rest = match[2] ?? '';
  } else {
    if (!options.vendorKey.startsWith('-')) return [];
    root = '/';
    rest = options.vendorKey.slice(1);
  }
  if (rest.length === 0) {
    const isDirectory = options.isDirectory ?? defaultIsDirectory;
    return (await isDirectory(root)) ? [root] : [];
  }

  const results = new Set<string>();
  let probes = 0;
  let overflow = false;
  const limit = options.maxProbes ?? 4000;
  // Enumerate ALL complete decodings (no ordering preference — order must never
  // decide identity). Every real child whose encoded name matches the current
  // remaining key prefix is explored, so ambiguity (more than one real directory
  // decoding to the same key) is still fully detectable.
  const walk = async (base: string, remaining: string): Promise<void> => {
    if (overflow) return;
    if (remaining.length === 0) {
      results.add(base);
      return;
    }
    if (probes >= limit) {
      overflow = true;
      return;
    }
    probes += 1;
    const children = await listDirs(base);
    for (const childName of children) {
      if (overflow) return;
      const encodedChild = encodeClaudeProjectKey(childName);
      if (remaining === encodedChild) {
        await walk(p.join(base, childName), '');
      } else if (remaining.startsWith(`${encodedChild}-`)) {
        await walk(p.join(base, childName), remaining.slice(encodedChild.length + 1));
      }
    }
  };
  await walk(root, rest);
  return overflow ? [] : [...results];
};

/**
 * Resolve a vendor key to its project directory ONLY when the decoding is
 * unambiguous — exactly one existing directory chain matches. Because
 * `encodeClaudeProjectKey` is lossy, multiple real directories can match one key; in
 * that case this returns `null` (fail closed) so an ambiguous inverse can never
 * silently authorize a strong project identity. Callers must not pick a winner by
 * length, order, or name preference.
 *
 * Used to resolve a native project's Git identity from its own checkout independent of
 * the current working directory, so `scan` and `backup` agree (Phase 15B.4).
 */
export const reconstructProjectDir = async (options: {
  vendorKey: string;
  isDirectory?: (candidate: string) => Promise<boolean>;
  listDirs?: (dir: string) => Promise<string[]>;
  platform?: NodeJS.Platform;
  maxProbes?: number;
}): Promise<string | null> => {
  const dirs = await reconstructProjectDirs(options);
  return dirs.length === 1 ? (dirs[0] as string) : null;
};

/**
 * A Cloud-safe, UI-safe display basename for a local directory (e.g. `nexus` from
 * `C:\Users\NT\Desktop\nexus`), never the path itself. `path.basename` cannot return a
 * string containing a path separator, so this can never smuggle directory structure.
 * Returns `undefined` when no safe basename can be determined (root/degenerate path).
 */
export const safeDirectoryBasename = (
  dir: string | null | undefined,
): string | undefined => {
  if (!dir) return undefined;
  const base = path.basename(dir).trim();
  if (!base || base === '.' || base === '..') return undefined;
  if (/[\\/]/.test(base)) return undefined;
  return base.slice(0, 200);
};

/** Whether two identities refer to the same project. */
export const projectIdentityMatches = (
  a: ProjectIdentity,
  b: ProjectIdentity,
): boolean => {
  if (a.kind === 'git' && b.kind === 'git')
    return a.canonical.toLowerCase() === b.canonical.toLowerCase();
  if (a.kind === 'local' && b.kind === 'local')
    return Boolean(a.vendorKey) && a.vendorKey === b.vendorKey;
  return false;
};

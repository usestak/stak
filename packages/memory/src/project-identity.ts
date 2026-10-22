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

/**
 * Every character `encodeClaudeProjectKey` can collapse to `-`, other than a path
 * separator (which `reconstructProjectDirs` handles separately by ending a span and
 * recursing into a new directory level). A `-` WITHIN a span — i.e. between two
 * tokens that remain in the SAME path segment — could originally have been any one
 * of these.
 */
const SEGMENT_SEPARATOR_CHARS = ['-', '.', '_', ' '] as const;

/** A span wider than this never gets full separator-variant expansion (only the
 * plain literal-`-` join, below) — `4^(width-1)` variants per span width makes an
 * UNBOUNDED width catastrophically expensive long before it is ever realistic:
 * trying every width up to "the rest of the path as one segment" at every walk
 * level is the dominant cost, and real directory names with a non-hyphen separator
 * (a dot, underscore, or space) are essentially never more than a handful of words.
 * Capped at a width whose full expansion (`4^(CAP-1)` = 64 variants) is cheap even
 * multiplied across many walk levels, while an arbitrarily long HYPHEN-only name
 * (the pre-existing, common case) is untouched below — it still costs exactly one
 * probe per width, identical to before this generalization. */
const MAX_VARIANT_SPAN_WIDTH = 4;

/** Every way to join `tokens[index..end]` (inclusive) into one candidate path-segment
 * name. Spans up to `MAX_VARIANT_SPAN_WIDTH` try every `SEGMENT_SEPARATOR_CHARS`
 * choice at every internal gap — all of which collapse to the exact same encoded
 * key, so all are valid candidate undoings of that span. Wider spans (and any
 * single-token span, which has no gap to choose) get only the plain literal `-`
 * join, matching this function's pre-generalization behavior exactly. */
const joinSegmentVariants = (
  tokens: string[],
  index: number,
  end: number,
): string[] => {
  if (end === index) return [tokens[index] ?? ''];
  if (end - index + 1 > MAX_VARIANT_SPAN_WIDTH)
    return [tokens.slice(index, end + 1).join('-')];
  let variants = [tokens[index] ?? ''];
  for (let i = index + 1; i <= end; i += 1) {
    const next: string[] = [];
    for (const variant of variants)
      for (const sep of SEGMENT_SEPARATOR_CHARS)
        next.push(`${variant}${sep}${tokens[i] ?? ''}`);
    variants = next;
  }
  return variants;
};

/**
 * Enumerate EVERY existing absolute directory that a Claude auto-memory vendor key
 * could decode to. `encodeClaudeProjectKey` is lossy — every non-alphanumeric
 * character (path separators, but also `.`, `_`, spaces, and other punctuation
 * WITHIN a segment's own name) all collapse to the same `-` — so a key such as
 * `...-foo-bar-baz` may correspond to `foo-bar\baz`, `foo\bar-baz`, `foo.bar\baz`,
 * `foo\bar_baz`, etc. This walks the real filesystem and returns all distinct paths
 * that fully decode to existing directory chains — the raw material for a SAFE,
 * unique-only resolution (see `reconstructProjectDir`). On probe-limit overflow it
 * returns `[]` (fail closed) rather than a partial/biased set.
 */
export const reconstructProjectDirs = async (options: {
  vendorKey: string;
  isDirectory: (candidate: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  maxProbes?: number;
}): Promise<string[]> => {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
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
  const tokens = rest.length > 0 ? rest.split('-') : [];
  if (tokens.length === 0)
    return (await options.isDirectory(root)) ? [root] : [];

  const results = new Set<string>();
  let probes = 0;
  let overflow = false;
  const limit = options.maxProbes ?? 4000;
  // Enumerate ALL complete decodings (no ordering preference — order must never
  // decide identity). Every split point AND every within-span separator choice is
  // explored so ambiguity is detectable.
  const walk = async (base: string, index: number): Promise<void> => {
    if (overflow) return;
    if (index >= tokens.length) {
      results.add(base);
      return;
    }
    for (let end = index; end < tokens.length && !overflow; end += 1) {
      for (const name of joinSegmentVariants(tokens, index, end)) {
        if (probes >= limit) {
          overflow = true;
          return;
        }
        probes += 1;
        const candidate = p.join(base, name);
        if (await options.isDirectory(candidate)) await walk(candidate, end + 1);
      }
    }
  };
  await walk(root, 0);
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
  isDirectory: (candidate: string) => Promise<boolean>;
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

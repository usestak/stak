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
 * directory under `~/.claude/projects/` (drive/path separators become `-`).
 * Deterministic forward-only; used to match a known local project to its
 * auto-memory directory. The result is a machine-local vendor key, never a
 * portable identity.
 */
export const encodeClaudeProjectKey = (absolutePath: string): string =>
  absolutePath.replace(/[:\\/]/g, '-');

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
 * Best-effort reconstruction of the absolute project directory a Claude auto-memory
 * vendor key was derived from (the inverse of `encodeClaudeProjectKey`, which is lossy
 * because `:`, `\`, and `/` all become `-`). Resolution is filesystem-validated: it
 * walks real directories, trying the longest name join first so path components that
 * themselves contain hyphens (e.g. `atlas-access-flow`) reconstruct correctly. Returns
 * the resolved directory, or null when it cannot be recovered.
 *
 * This lets Git identity be resolved from the project's own checkout independent of the
 * current working directory, so `scan` and `backup` agree (Phase 15B.4).
 */
export const reconstructProjectDir = async (options: {
  vendorKey: string;
  isDirectory: (candidate: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  maxProbes?: number;
}): Promise<string | null> => {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  let root: string;
  let rest: string;
  if (platform === 'win32') {
    const match = /^([A-Za-z])--(.*)$/.exec(options.vendorKey);
    if (!match) return null;
    root = `${match[1]}:\\`;
    rest = match[2] ?? '';
  } else {
    if (!options.vendorKey.startsWith('-')) return null;
    root = '/';
    rest = options.vendorKey.slice(1);
  }
  const tokens = rest.length > 0 ? rest.split('-') : [];
  if (tokens.length === 0)
    return (await options.isDirectory(root)) ? root : null;

  let probes = 0;
  const limit = options.maxProbes ?? 4000;
  const walk = async (base: string, index: number): Promise<string | null> => {
    if (index >= tokens.length) return base;
    // Longest name join first so hyphenated directory names win over prefixes.
    for (let end = tokens.length - 1; end >= index; end -= 1) {
      if (probes >= limit) return null;
      probes += 1;
      const name = tokens.slice(index, end + 1).join('-');
      const candidate = p.join(base, name);
      if (await options.isDirectory(candidate)) {
        const resolved = await walk(candidate, end + 1);
        if (resolved) return resolved;
      }
    }
    return null;
  };
  return walk(root, 0);
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

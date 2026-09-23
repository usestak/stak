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

/** Stable key for grouping/logical-id purposes. */
export const projectIdentityKey = (identity: ProjectIdentity): string =>
  identity.kind === 'git'
    ? identity.canonical
    : `local:${identity.vendorKey ?? 'unresolved'}`;

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

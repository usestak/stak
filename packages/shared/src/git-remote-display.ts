/**
 * The one centralized, safe display identity for a Git remote (P5 visual-correction pass,
 * item §4). A Skill's `restoration.reference.remote` is a real, user-supplied Git remote —
 * `portableRemoteSchema` only constrains its URL SHAPE (https/ssh/git/SCP-style), never
 * guarantees it is free of embedded userinfo credentials, a query string, or a fragment.
 * Rendering it verbatim is never safe. This extracts only `{ host, ownerRepo }` — exactly the
 * two facts a human needs to answer "where did this come from?" — and is the only place in the
 * codebase allowed to parse a raw remote string for display. Everything else (web, Cloud read
 * models) consumes its output, never the raw remote again.
 *
 * Returns null when the remote cannot be parsed into a safe identity — callers must fall back
 * to a generic "Git source" label, never to the raw string.
 */
export type SafeGitRemoteDisplay = {
  host: string;
  /** Repository-relative identity (e.g. "owner/repo"), with no leading/trailing slashes and
   *  no trailing ".git". Null if the remote has no path component to show. */
  ownerRepo: string | null;
};

const normalizePath = (path: string): string | null => {
  const trimmed = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return trimmed.length > 0 ? trimmed : null;
};

// SCP-style: user@host:path — e.g. git@github.com:owner/repo.git. Never matches a URL with an
// explicit scheme (those are parsed below), since "https://user:pass@host/x" would otherwise
// also match this shape with ":" after the first "/".
const SCP_STYLE = /^[^/\\:@\s]+@([^/\\:\s]+):(.+)$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const safeGitRemoteDisplay = (
  remote: string,
): SafeGitRemoteDisplay | null => {
  if (!HAS_SCHEME.test(remote)) {
    const scp = SCP_STYLE.exec(remote);
    if (scp) {
      const [, host, path] = scp;
      if (!host) return null;
      return { host, ownerRepo: normalizePath(path ?? '') };
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (!['https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
  if (!url.hostname) return null;
  // Deliberately read ONLY hostname + pathname. url.username/url.password (userinfo
  // credentials), url.search (query-string credentials/tokens), and url.hash (auth fragments)
  // are never read here — this is what makes the function safe by construction.
  return { host: url.hostname, ownerRepo: normalizePath(url.pathname) };
};

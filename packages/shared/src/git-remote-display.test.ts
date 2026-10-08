import { describe, expect, it } from 'vitest';

import { safeGitRemoteDisplay } from './git-remote-display.js';

describe('safeGitRemoteDisplay', () => {
  it('extracts host + owner/repo from an https remote, stripping .git', () => {
    expect(safeGitRemoteDisplay('https://github.com/acme/skills.git')).toEqual({
      host: 'github.com',
      ownerRepo: 'acme/skills',
    });
  });

  it('never surfaces embedded userinfo credentials from an https remote', () => {
    const result = safeGitRemoteDisplay(
      'https://oauth2:ghp_SECRETTOKEN123@github.com/acme/skills.git',
    );
    expect(result).toEqual({ host: 'github.com', ownerRepo: 'acme/skills' });
    expect(JSON.stringify(result)).not.toContain('SECRETTOKEN');
    expect(JSON.stringify(result)).not.toContain('oauth2');
  });

  it('never surfaces a query-string token or an auth fragment', () => {
    const result = safeGitRemoteDisplay(
      'https://github.com/acme/skills.git?token=abc123#auth=xyz',
    );
    expect(result).toEqual({ host: 'github.com', ownerRepo: 'acme/skills' });
    expect(JSON.stringify(result)).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('xyz');
  });

  it('parses an ssh:// remote', () => {
    expect(
      safeGitRemoteDisplay('ssh://git@github.com/acme/skills.git'),
    ).toEqual({ host: 'github.com', ownerRepo: 'acme/skills' });
  });

  it('parses an SCP-style remote without leaking the user', () => {
    const result = safeGitRemoteDisplay('git@github.com:acme/skills.git');
    expect(result).toEqual({ host: 'github.com', ownerRepo: 'acme/skills' });
    expect(JSON.stringify(result)).not.toContain('git@');
  });

  it('parses a self-hosted GitLab subgroup path', () => {
    expect(
      safeGitRemoteDisplay('https://gitlab.example.com/group/sub/repo.git'),
    ).toEqual({ host: 'gitlab.example.com', ownerRepo: 'group/sub/repo' });
  });

  it('drops a non-standard port rather than leaking it as part of the host', () => {
    const result = safeGitRemoteDisplay(
      'https://user:pass@example.com:8443/group/repo.git',
    );
    expect(result?.host).toBe('example.com');
    expect(JSON.stringify(result)).not.toContain('8443');
    expect(JSON.stringify(result)).not.toContain('pass');
  });

  it('returns null for an unparsable or unsupported scheme', () => {
    expect(safeGitRemoteDisplay('not a remote at all')).toBeNull();
    expect(safeGitRemoteDisplay('file:///home/user/repo')).toBeNull();
  });

  it('returns a null ownerRepo (never a fabricated one) when the remote has no path', () => {
    expect(safeGitRemoteDisplay('https://github.com')).toEqual({
      host: 'github.com',
      ownerRepo: null,
    });
  });
});

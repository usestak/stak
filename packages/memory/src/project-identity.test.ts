import { describe, expect, it } from 'vitest';

import {
  canonicalGitIdentity,
  encodeClaudeProjectKey,
  projectIdentityMatches,
} from './project-identity.js';

describe('canonicalGitIdentity', () => {
  it('normalizes https, ssh/scp, and trailing .git to one identity', () => {
    const expected = {
      kind: 'git',
      host: 'github.com',
      owner: 'stephentony100',
      repo: 'nado',
      canonical: 'github.com/stephentony100/nado',
    };
    for (const remote of [
      'https://github.com/stephentony100/nado.git',
      'https://github.com/stephentony100/nado',
      'git@github.com:stephentony100/nado.git',
      'ssh://git@github.com/stephentony100/nado.git',
    ])
      expect(canonicalGitIdentity(remote)).toEqual(expected);
  });

  it('strips embedded credentials from the remote URL', () => {
    const identity = canonicalGitIdentity(
      'https://user:ghp_secrettoken@github.com/stephentony100/nado.git',
    );
    expect(identity).toEqual({
      kind: 'git',
      host: 'github.com',
      owner: 'stephentony100',
      repo: 'nado',
      canonical: 'github.com/stephentony100/nado',
    });
    expect(JSON.stringify(identity)).not.toContain('ghp_secrettoken');
  });

  it('lowercases the host but preserves owner/repo path casing', () => {
    expect(
      canonicalGitIdentity('git@GitHub.com:Acme/Repo.git')?.canonical,
    ).toBe('github.com/Acme/Repo');
  });

  it('returns null when no portable identity exists', () => {
    expect(canonicalGitIdentity(undefined)).toBeNull();
    expect(canonicalGitIdentity('')).toBeNull();
    expect(canonicalGitIdentity('not-a-remote')).toBeNull();
  });
});

describe('encodeClaudeProjectKey', () => {
  it('matches the observed Claude vendor-key encoding', () => {
    expect(encodeClaudeProjectKey('C:\\Users\\NT\\Desktop\\stack')).toBe(
      'C--Users-NT-Desktop-stack',
    );
  });
});

describe('projectIdentityMatches', () => {
  it('recognizes the same project across moved directories via Git identity', () => {
    const a = canonicalGitIdentity(
      'https://github.com/stephentony100/nado.git',
    );
    const b = canonicalGitIdentity('git@github.com:stephentony100/nado.git');
    if (!a || !b) throw new Error('expected git identities');
    expect(projectIdentityMatches(a, b)).toBe(true);
  });

  it('does not match unrelated local directories', () => {
    expect(
      projectIdentityMatches(
        { kind: 'local', vendorKey: 'C--a' },
        { kind: 'local', vendorKey: 'D--b' },
      ),
    ).toBe(false);
  });

  it('never conflates a git and a local identity', () => {
    const git = canonicalGitIdentity('https://github.com/o/r');
    if (!git) throw new Error('expected git identity');
    expect(projectIdentityMatches(git, { kind: 'local', vendorKey: 'x' })).toBe(
      false,
    );
  });
});

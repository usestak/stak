import { describe, expect, it } from 'vitest';

import {
  PublicStackRefError,
  formatPublicStackRef,
  inspectPublicSourceRemote,
  isSafeDisplayUrl,
  parsePublicStackRef,
} from './public.js';

describe('parsePublicStackRef', () => {
  it('parses @owner/name', () => {
    expect(parsePublicStackRef('@temi/frontend')).toEqual({
      owner: 'temi',
      slug: 'frontend',
    });
  });

  it.each([
    'temi/frontend', // no @
    '@temi', // no slug
    '@temi/frontend/extra', // extra segment
    '@temi/../etc', // traversal
    '@/frontend', // empty owner
    '@temi/', // empty slug
    '@Temi/frontend', // uppercase handle
    '@temi/Frontend', // uppercase slug ok? slug is lowercase only
  ])('rejects %s', (input) => {
    expect(() => parsePublicStackRef(input)).toThrow(PublicStackRefError);
  });
});

describe('formatPublicStackRef', () => {
  // Regression: the CLI locator (`@owner/slug`) and the canonical browser share URL
  // (`/owner/slug`, built in cloud-server's public-service.ts/user-stack-service.ts) are
  // deliberately different grammars. This formatter is the CLI side only — it must always
  // keep the leading `@`, never drift toward the bare web path form.
  it('always keeps the leading @ (CLI locator, never the browser URL form)', () => {
    const ref = formatPublicStackRef({
      owner: 'stephentony100',
      slug: 'frontend-test',
    });
    expect(ref).toBe('@stephentony100/frontend-test');
    expect(ref.startsWith('@')).toBe(true);
  });
});

describe('inspectPublicSourceRemote', () => {
  it('accepts clean https, ssh, git, and scp remotes', () => {
    expect(inspectPublicSourceRemote('https://github.com/o/r.git').safe).toBe(
      true,
    );
    expect(inspectPublicSourceRemote('ssh://git@github.com/o/r.git').safe).toBe(
      true,
    );
    expect(inspectPublicSourceRemote('git://github.com/o/r.git').safe).toBe(
      true,
    );
    expect(inspectPublicSourceRemote('git@github.com:o/r.git').safe).toBe(true);
  });

  it.each([
    'https://token@github.com/o/r.git',
    'https://user:pass@github.com/o/r.git',
    'file:///home/me/repo',
    '/home/me/repo',
    'C:/Users/me/repo',
    'https://localhost/o/r.git',
    'https://127.0.0.1/o/r.git',
    'weird://github.com/o/r.git',
  ])('rejects unsafe remote %s', (remote) => {
    const verdict = inspectPublicSourceRemote(remote);
    expect(verdict.safe).toBe(false);
  });

  it('never echoes credential material in the reason', () => {
    const verdict = inspectPublicSourceRemote(
      'https://supersecret@github.com/o/r.git',
    );
    expect(verdict.safe).toBe(false);
    if (!verdict.safe) expect(verdict.reason).not.toContain('supersecret');
  });
});

describe('isSafeDisplayUrl', () => {
  it('allows http(s) without credentials', () => {
    expect(isSafeDisplayUrl('https://github.com/o/r')).toBe(true);
    expect(isSafeDisplayUrl('http://example.com')).toBe(true);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'ssh://git@github.com/o/r',
    'https://user:pass@github.com/o/r',
    'git@github.com:o/r.git',
  ])('rejects %s', (value) => {
    expect(isSafeDisplayUrl(value)).toBe(false);
  });
});

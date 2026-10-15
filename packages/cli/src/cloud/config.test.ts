import { describe, expect, it } from 'vitest';

import {
  buildOpenUrl,
  resolveCloudAppUrl,
  resolveCloudBaseUrl,
} from './config.js';

describe('resolveCloudBaseUrl env aliases (R3)', () => {
  it('prefers STAK_API_URL', () => {
    expect(
      resolveCloudBaseUrl({ env: { STAK_API_URL: 'https://api.stak.test' } }),
    ).toBe('https://api.stak.test');
  });

  it('accepts legacy STACK_API_URL', () => {
    expect(
      resolveCloudBaseUrl({ env: { STACK_API_URL: 'https://api.stak.test' } }),
    ).toBe('https://api.stak.test');
  });

  it('accepts both when they only differ by a trailing slash', () => {
    expect(
      resolveCloudBaseUrl({
        env: {
          STAK_API_URL: 'https://api.stak.test',
          STACK_API_URL: 'https://api.stak.test/',
        },
      }),
    ).toBe('https://api.stak.test');
  });

  it('fails when STAK_API_URL and STACK_API_URL conflict', () => {
    expect(() =>
      resolveCloudBaseUrl({
        env: {
          STAK_API_URL: 'https://a.test',
          STACK_API_URL: 'https://b.test',
        },
      }),
    ).toThrow(/STAK_API_URL.*STACK_API_URL/s);
  });

  // Release-gate finding (2026-10-15): an unconfigured installed CLI MUST reach
  // real STAK Cloud, not a developer's local server — requiring an ordinary end
  // user to set an env var just to make `stak login` work is backwards for a
  // published package. See packages/cli/src/program.test.ts for the live-defect
  // regression (`stak login` silently targeting localhost with nothing set).
  it('an unconfigured CLI defaults to production (the core release-gate rule)', () => {
    expect(resolveCloudBaseUrl({ env: {} })).toBe('https://www.memstk.com');
  });

  it('an explicit --api-url override still wins over every other source', () => {
    expect(
      resolveCloudBaseUrl({
        env: { STAK_API_URL: 'https://api.stak.test' },
        storedApiUrl: 'https://stored.stak.test',
        override: 'https://override.stak.test',
      }),
    ).toBe('https://override.stak.test');
  });

  it('STAK_API_URL is used at its intended precedence (above stored, below override)', () => {
    expect(
      resolveCloudBaseUrl({
        env: { STAK_API_URL: 'https://api.stak.test' },
        storedApiUrl: 'https://stored.stak.test',
      }),
    ).toBe('https://api.stak.test');
  });

  it('a previously stored API URL is used when nothing else overrides it', () => {
    expect(
      resolveCloudBaseUrl({
        env: {},
        storedApiUrl: 'https://stored.stak.test',
      }),
    ).toBe('https://stored.stak.test');
  });

  it('STAK_ENV=development explicitly opts into the localhost fallback', () => {
    expect(resolveCloudBaseUrl({ env: { STAK_ENV: 'development' } })).toBe(
      'http://localhost:3000',
    );
  });

  it('legacy STACK_ENV=development also opts into the localhost fallback', () => {
    expect(resolveCloudBaseUrl({ env: { STACK_ENV: 'development' } })).toBe(
      'http://localhost:3000',
    );
  });

  it('STAK_ENV=local is also an explicit local signal', () => {
    expect(resolveCloudBaseUrl({ env: { STAK_ENV: 'local' } })).toBe(
      'http://localhost:3000',
    );
  });

  it('NODE_ENV=development is also an explicit local signal', () => {
    expect(resolveCloudBaseUrl({ env: { NODE_ENV: 'development' } })).toBe(
      'http://localhost:3000',
    );
  });

  it('an UNSET environment never implies development — the exact regression this fixes', () => {
    // No STAK_ENV, no STACK_ENV, no NODE_ENV, no stored/override URL at all —
    // this is the real shape of a fresh `npm install -g @memstk/cli` + `stak login`.
    expect(resolveCloudBaseUrl({ env: {} })).not.toBe('http://localhost:3000');
    expect(resolveCloudBaseUrl({ env: {} })).toBe('https://www.memstk.com');
  });

  it('STAK_ENV=production no longer has special meaning — production is already the default', () => {
    // Kept only so a caller who still sets this legacy flag doesn't regress to
    // localhost; it simply isn't "local", so it resolves to production either way.
    expect(resolveCloudBaseUrl({ env: { STAK_ENV: 'production' } })).toBe(
      'https://www.memstk.com',
    );
  });

  it('legacy STACK_ENV=production behaves the same way', () => {
    expect(resolveCloudBaseUrl({ env: { STACK_ENV: 'production' } })).toBe(
      'https://www.memstk.com',
    );
  });
});

describe('resolveCloudAppUrl (P4 — stak open target)', () => {
  it('prefers STAK_APP_URL over the legacy alias and over the dev fallback', () => {
    expect(
      resolveCloudAppUrl({ env: { STAK_APP_URL: 'https://app.stak.test' } }),
    ).toBe('https://app.stak.test');
    expect(
      resolveCloudAppUrl({ env: { STACK_APP_URL: 'https://app.stak.test' } }),
    ).toBe('https://app.stak.test');
  });

  it('an unconfigured CLI opens real STAK Cloud, not localhost', () => {
    expect(resolveCloudAppUrl({ env: {} })).toBe('https://www.memstk.com');
  });

  it('STAK_ENV=development explicitly opts into the localhost fallback', () => {
    expect(resolveCloudAppUrl({ env: { STAK_ENV: 'development' } })).toBe(
      'http://localhost:3000',
    );
  });
});

describe('buildOpenUrl (P4)', () => {
  const machine = '00000000-0000-4000-8000-0000000000a1';

  it('builds the Overview URL with the machine id as the only query param', () => {
    expect(buildOpenUrl('https://app.stak.test', machine)).toBe(
      `https://app.stak.test/overview?machine=${machine}`,
    );
  });

  it('preserves an existing path/query and URL-encodes the machine id', () => {
    const raw = buildOpenUrl('https://app.stak.test/base?x=1', 'a b/c');
    const url = new URL(raw);
    expect(url.pathname).toBe('/base/overview');
    expect(url.searchParams.get('machine')).toBe('a b/c'); // round-trips
    expect(url.searchParams.get('x')).toBe('1'); // existing query preserved
    // No literal space or slash leaks into the machine value (it is encoded).
    expect(raw).not.toContain('machine=a b');
    expect(raw).toContain('machine=a+b%2Fc');
  });

  it('places NO token/secret/Memory in the URL — only `machine`', () => {
    const url = new URL(buildOpenUrl('http://localhost:3000', machine));
    expect([...url.searchParams.keys()]).toEqual(['machine']);
  });
});

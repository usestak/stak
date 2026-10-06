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

  it('falls back to localhost in dev when nothing is configured', () => {
    expect(resolveCloudBaseUrl({ env: {} })).toBe('http://localhost:3000');
  });

  it('STAK_ENV=production disables the dev fallback (fails closed)', () => {
    expect(() =>
      resolveCloudBaseUrl({ env: { STAK_ENV: 'production' } }),
    ).toThrow();
  });

  it('legacy STACK_ENV=production also disables the dev fallback', () => {
    expect(() =>
      resolveCloudBaseUrl({ env: { STACK_ENV: 'production' } }),
    ).toThrow();
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

  it('falls back to localhost in development, fails closed in production', () => {
    expect(resolveCloudAppUrl({ env: {} })).toBe('http://localhost:3000');
    expect(() =>
      resolveCloudAppUrl({ env: { STAK_ENV: 'production' } }),
    ).toThrow();
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

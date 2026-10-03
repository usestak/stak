import { describe, expect, it } from 'vitest';

import { resolveCloudBaseUrl } from './config.js';

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

import { describe, test, expect, vi } from 'vitest';
import { siteOrigin } from './site-origin';

describe('siteOrigin', () => {
  test('returns STAK_APP_URL when set', () => {
    vi.stubEnv('STAK_APP_URL', 'https://usestak.app');
    expect(siteOrigin()).toBe('https://usestak.app');
  });

  test('falls back to localhost outside production', () => {
    vi.stubEnv('STAK_APP_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(siteOrigin()).toBe('http://localhost:3000');
  });

  test('throws rather than emit a bogus localhost canonical in production with no origin configured', () => {
    vi.stubEnv('STAK_APP_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => siteOrigin()).toThrow();
  });
});

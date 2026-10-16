import { afterEach, describe, expect, test, vi } from 'vitest';

const getPublicStack = vi.fn();
vi.mock('../../../lib/cloud-service', () => ({
  getCloudService: () => ({ getPublicStack }),
}));
vi.mock('../../../lib/site-origin', () => ({
  siteOrigin: () => 'https://www.memstk.com',
}));

import { generateMetadata } from './page';

afterEach(() => {
  vi.clearAllMocks();
});

const stack = {
  owner: 'stephentony100',
  slug: 'frontend-test',
  displayName: 'frontend-test',
  description: null,
  updatedAt: '2026-01-01T00:00:00Z',
  latest: null,
};

/**
 * Regression for the public-share-link bug: the CLI locator (`@owner/slug`, parsed by
 * `parsePublicStackRef` in @stack/spec) and the canonical browser URL are deliberately
 * different grammars — the web UI must never emit the `@` form as a browser link.
 */
describe('public STAK canonical URL', () => {
  test('never contains the CLI-style @owner — route param is the bare handle', async () => {
    getPublicStack.mockResolvedValue(stack);
    const metadata = await generateMetadata({
      params: Promise.resolve({
        owner: 'stephentony100',
        slug: 'frontend-test',
      }),
    });
    expect(getPublicStack).toHaveBeenCalledWith(
      'stephentony100',
      'frontend-test',
    );
    const canonical = metadata.alternates?.canonical;
    expect(canonical).toBe(
      'https://www.memstk.com/stephentony100/frontend-test',
    );
    expect(String(canonical)).not.toContain('@');
  });
});

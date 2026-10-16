import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const getPublicProfile = vi.fn();
vi.mock('../../lib/cloud-service', () => ({
  getCloudService: () => ({ getPublicProfile }),
}));
vi.mock('../../lib/site-origin', () => ({
  siteOrigin: () => 'https://www.memstk.com',
}));

import ProfilePage, { generateMetadata } from './page';

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const profile = {
  owner: 'stephentony100',
  displayName: null,
  stacks: [
    {
      slug: 'frontend-test',
      displayName: 'frontend-test',
      description: null,
      kind: 'stack' as const,
      latestVersionNumber: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

/**
 * Regression for the public-share-link bug: a profile's STAK links must point at the
 * canonical `/owner/slug` browser path, never the CLI-style `/@owner/slug` form.
 */
describe('public profile STAK links', () => {
  test('generateMetadata canonical URL never contains @', async () => {
    getPublicProfile.mockResolvedValue(profile);
    const metadata = await generateMetadata({
      params: Promise.resolve({ owner: 'stephentony100' }),
    });
    expect(getPublicProfile).toHaveBeenCalledWith('stephentony100');
    expect(metadata.alternates?.canonical).toBe(
      'https://www.memstk.com/stephentony100',
    );
    expect(String(metadata.alternates?.canonical)).not.toContain('@');
  });

  test('STAK card links use the bare-owner path, not the @owner CLI form', async () => {
    getPublicProfile.mockResolvedValue(profile);
    const element = await ProfilePage({
      params: Promise.resolve({ owner: 'stephentony100' }),
    });
    render(element);
    const link = screen.getByRole('link', { name: /frontend-test/i });
    expect(link).toHaveAttribute('href', '/stephentony100/frontend-test');
  });
});

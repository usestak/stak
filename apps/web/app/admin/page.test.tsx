import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadOverviewMetricsMock } = vi.hoisted(
  () => ({
    getAdminUserMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    loadOverviewMetricsMock: vi.fn().mockResolvedValue({
      totalUsers: 10,
      newUsers: 2,
      activatedUsers: 3,
      activationRate: 0.3,
      portableUsers: 1,
      newFeedback: 1,
      openFeedback: 2,
      pushPullSuccessRate: 'unavailable',
    }),
  }),
);

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./overview-data', () => ({
  loadOverviewMetrics: loadOverviewMetricsMock,
}));

import AdminOverviewPage from './page';

describe('AdminOverviewPage', () => {
  it('calls notFound (its own gate, independent of the layout) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminOverviewPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadOverviewMetricsMock).not.toHaveBeenCalled();
  });

  it('renders metrics for an admin user, defaulting to the "30d" range', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminOverviewPage({
      searchParams: Promise.resolve({}),
    });
    expect(loadOverviewMetricsMock).toHaveBeenCalledWith({}, '30d');
    expect(JSON.stringify(result)).toContain('10'); // totalUsers rendered somewhere
  });
});

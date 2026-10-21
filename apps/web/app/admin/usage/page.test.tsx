import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadUsageMetricsMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadUsageMetricsMock: vi.fn().mockResolvedValue({
    pushesPerDay: [],
    pullsPerDay: [],
    activeMachines: 0,
    memoryBackupsCount: 0,
    memoryRecoveriesCount: 0,
    publicStakPublications: 0,
  }),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./usage-data', () => ({ loadUsageMetrics: loadUsageMetricsMock }));

import AdminUsagePage from './page';

describe('AdminUsagePage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminUsagePage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(loadUsageMetricsMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user, defaulting to "30d"', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminUsagePage({ searchParams: Promise.resolve({}) });
    expect(loadUsageMetricsMock).toHaveBeenCalledWith({}, '30d');
  });
});

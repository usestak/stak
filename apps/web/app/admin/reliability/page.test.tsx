import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadReliabilityMetricsMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadReliabilityMetricsMock: vi.fn().mockResolvedValue({
    pushSuccessRate: null,
    pullSuccessRate: null,
    recentFailures: [],
  }),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./reliability-data', () => ({ loadReliabilityMetrics: loadReliabilityMetricsMock }));

import AdminReliabilityPage from './page';

describe('AdminReliabilityPage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminReliabilityPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(loadReliabilityMetricsMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user, defaulting to "30d"', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminReliabilityPage({ searchParams: Promise.resolve({}) });
    expect(loadReliabilityMetricsMock).toHaveBeenCalledWith({}, '30d');
  });
});

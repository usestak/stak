import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadActivationFunnelMock } = vi.hoisted(
  () => ({
    getAdminUserMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    loadActivationFunnelMock: vi.fn().mockResolvedValue({
      accounts: 10,
      cliAuthenticated: 5,
      firstPush: 3,
      portable: 1,
    }),
  }),
);

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./activation-data', () => ({
  loadActivationFunnel: loadActivationFunnelMock,
}));

import AdminActivationPage from './page';

describe('AdminActivationPage', () => {
  it('calls notFound (its own gate) when there is no admin user, before fetching the funnel', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminActivationPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadActivationFunnelMock).not.toHaveBeenCalled();
  });

  it('renders the funnel for an admin user', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminActivationPage();
    expect(loadActivationFunnelMock).toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('10');
  });
});

// apps/web/app/admin/system/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadSystemStatusMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadSystemStatusMock: vi.fn().mockResolvedValue({
    webVersion: '0.1.0',
    cliVersion: '0.2.0-beta.1',
    dbConnected: true,
    recentFailureCount: 0,
  }),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./system-data', () => ({ loadSystemStatus: loadSystemStatusMock }));

import AdminSystemPage from './page';

describe('AdminSystemPage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminSystemPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadSystemStatusMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminSystemPage();
    expect(loadSystemStatusMock).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});

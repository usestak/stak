import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadUsersMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadUsersMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./users-data', () => ({ loadUsers: loadUsersMock }));

import AdminUsersPage from './page';

describe('AdminUsersPage', () => {
  it('calls notFound (its own gate) when there is no admin user, before fetching users', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminUsersPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadUsersMock).not.toHaveBeenCalled();
  });

  it('loads users for an admin, passing the search query through', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminUsersPage({ searchParams: Promise.resolve({ q: 'ada' }) });
    expect(loadUsersMock).toHaveBeenCalledWith({}, 'ada');
  });
});

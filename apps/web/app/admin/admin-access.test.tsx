// apps/web/app/admin/admin-access.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { notFoundMock, getAdminUserMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  getAdminUserMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('@/lib/admin', () => ({
  getAdminUser: getAdminUserMock,
}));

import AdminLayout from './layout';

describe('admin access control', () => {
  it('A: anonymous visitor (no session) cannot reach /admin — notFound is called', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('B: authenticated non-admin user cannot reach /admin — notFound is called', async () => {
    // getAdminUser() itself returns null for a signed-in non-admin (verified
    // in admin.test.ts); the layout has no separate branch for this case, so
    // the same assertion as A covers it at this boundary.
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('C: admin user can access — layout renders children without calling notFound', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminLayout({ children: <div data-testid="child" /> });
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});

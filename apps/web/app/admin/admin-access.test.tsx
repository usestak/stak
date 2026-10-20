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

  it('B: authenticated non-admin user cannot reach /admin — notFound is called even though getAdminUser rejects', async () => {
    // Distinct from A's "no session at all" case: this simulates the lookup
    // step itself failing (e.g. a transient admin_users query error) rather
    // than getAdminUser() cleanly resolving to null. The layout must treat
    // any non-success outcome as "no access" — it must not let an unhandled
    // rejection skip the notFound() gate.
    getAdminUserMock.mockRejectedValue(new Error('admin_users lookup failed'));
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow();
  });

  it('C: admin user can access — layout renders children without calling notFound', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminLayout({ children: <div data-testid="child" /> });
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'div',
      props: { className: 'stak-admin' },
    });
  });
});

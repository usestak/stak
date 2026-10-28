// apps/web/app/admin/admin-access.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A: anonymous visitor (no session) cannot reach /admin — notFound is called', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('B: layout never renders children if getAdminUser() ever rejected (belt-and-suspenders; the real getAdminUser() in lib/admin.ts is contracted to never throw — see admin.test.ts)', async () => {
    // The layout itself has no try/catch around getAdminUser() — if the
    // mocked dependency rejects, the `if (!admin) notFound()` line never
    // executes, so notFound() is NOT called here. The rejection propagates
    // instead, and Next.js's error boundary renders — children still never
    // render, so this remains fail-closed, just via a different path than
    // test A's clean null case. The real admin.ts is fixed (try/catch) so
    // this scenario shouldn't occur in production; this test documents what
    // the layout does if that contract were ever violated.
    getAdminUserMock.mockRejectedValue(new Error('admin_users lookup failed'));
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow(
      'admin_users lookup failed',
    );
    expect(notFoundMock).not.toHaveBeenCalled();
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

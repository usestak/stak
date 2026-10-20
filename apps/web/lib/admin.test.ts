// apps/web/lib/admin.test.ts
import { describe, expect, it, vi } from 'vitest';

const { getSessionUserMock, fromMock } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('./session', () => ({
  getSessionUser: getSessionUserMock,
}));

vi.mock('./supabase', () => ({
  serviceClient: () => ({ from: fromMock }),
}));

import { getAdminUser } from './admin';

describe('getAdminUser', () => {
  it('returns null when there is no signed-in session', async () => {
    getSessionUserMock.mockResolvedValue(null);
    const result = await getAdminUser();
    expect(result).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns null when the signed-in user is not in admin_users', async () => {
    getSessionUserMock.mockResolvedValue({ id: 'user-1', displayName: 'Ada' });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const result = await getAdminUser();
    expect(result).toBeNull();
    expect(fromMock).toHaveBeenCalledWith('admin_users');
    expect(select).toHaveBeenCalledWith('role');
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns the admin user with role when present in admin_users', async () => {
    getSessionUserMock.mockResolvedValue({ id: 'user-1', displayName: 'Ada' });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { role: 'owner' }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const result = await getAdminUser();
    expect(result).toEqual({ id: 'user-1', displayName: 'Ada', role: 'owner' });
  });
});

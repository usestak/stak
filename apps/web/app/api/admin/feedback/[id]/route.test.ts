import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, updateMock, eqMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({ error: null }),
  eqMock: vi.fn(() => ({ error: null })),
}));
vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));

vi.mock('@/lib/supabase', () => ({
  serviceClient: () => ({
    from: () => ({
      update: (fields: unknown) => {
        updateMock(fields);
        return { eq: eqMock };
      },
    }),
  }),
}));

import { PATCH } from './route';

const req = (body: unknown) =>
  new Request('https://www.memstk.com/api/admin/feedback/f1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const ctx = { params: Promise.resolve({ id: 'f1' }) };

describe('PATCH /api/admin/feedback/[id]', () => {
  it('G: non-admin user cannot modify feedback status/note -- 404, no update attempted', async () => {
    getAdminUserMock.mockResolvedValue(null);
    const res = await PATCH(req({ status: 'resolved' }), ctx);
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('H: admin user can modify feedback status and note', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({ status: 'resolved', adminNote: 'Fixed in v2.' }), ctx);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        admin_note: 'Fixed in v2.',
        resolved_at: expect.any(String),
        resolved_by: 'admin-1',
      }),
    );
  });

  it('rejects an invalid status value without touching the database', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({ status: 'not-a-real-status' }), ctx);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not set resolved_at/resolved_by for a non-resolved status change', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    await PATCH(req({ status: 'reviewing' }), ctx);
    const fields = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('resolved_at');
    expect(fields).not.toHaveProperty('resolved_by');
  });
});

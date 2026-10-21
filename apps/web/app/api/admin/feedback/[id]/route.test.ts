import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, updateMock, eqMock, selectMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  updateMock: vi.fn(),
  eqMock: vi.fn(),
  selectMock: vi.fn().mockResolvedValue({ data: [{ id: 'f1' }], error: null }),
}));
vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));

vi.mock('@/lib/supabase', () => ({
  serviceClient: () => ({
    from: () => ({
      update: (fields: unknown) => {
        updateMock(fields);
        return {
          eq: (...args: unknown[]) => {
            eqMock(...args);
            return { select: selectMock };
          },
        };
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

  it('clears resolved_at/resolved_by (does not stamp them) for a non-resolved status change', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    await PATCH(req({ status: 'reviewing' }), ctx);
    const fields = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.resolved_at).toBeNull();
    expect(fields.resolved_by).toBeNull();
  });

  it('rejects an admin note over the length cap without touching the database', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({ adminNote: 'x'.repeat(2001) }), ctx);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects an update with no recognized fields without touching the database', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({}), ctx);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the feedback id does not exist (update matched zero rows)', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    selectMock.mockResolvedValueOnce({ data: [], error: null });
    const res = await PATCH(req({ status: 'resolved' }), ctx);
    expect(res.status).toBe(404);
  });
});

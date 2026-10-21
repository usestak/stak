import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadFeedbackListMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadFeedbackListMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./feedback-data', () => ({ loadFeedbackList: loadFeedbackListMock }));

import AdminFeedbackPage from './page';

describe('AdminFeedbackPage', () => {
  it('calls notFound (its own gate) when there is no admin user, before fetching feedback', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminFeedbackPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(loadFeedbackListMock).not.toHaveBeenCalled();
  });

  it('loads feedback for an admin, defaulting to the "all" filter', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminFeedbackPage({ searchParams: Promise.resolve({}) });
    expect(loadFeedbackListMock).toHaveBeenCalledWith({}, 'all');
  });
});

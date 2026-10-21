import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadFeedbackDetailMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadFeedbackDetailMock: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./feedback-detail-data', () => ({ loadFeedbackDetail: loadFeedbackDetailMock }));
vi.mock('./feedback-status-form', () => ({ FeedbackStatusForm: () => null }));

import AdminFeedbackDetailPage from './page';

describe('AdminFeedbackDetailPage', () => {
  it('E: non-admin user cannot read feedback -- notFound is called, loader never runs', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'f1' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadFeedbackDetailMock).not.toHaveBeenCalled();
  });

  it('F: admin user can read feedback -- renders the detail', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    loadFeedbackDetailMock.mockResolvedValue({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: null,
      email: null,
      pageUrl: null,
      userId: null,
      appVersion: null,
      createdAt: '2026-10-19T10:00:00Z',
      status: 'new',
      adminNote: null,
      resolvedAt: null,
    });
    const result = await AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'f1' }) });
    expect(loadFeedbackDetailMock).toHaveBeenCalledWith({}, 'f1');
    expect(result).toBeTruthy();
  });

  it('calls notFound when the feedback id does not exist, even for an admin', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    loadFeedbackDetailMock.mockResolvedValue(null);
    await expect(
      AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'missing' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

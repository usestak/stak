import { describe, expect, it } from 'vitest';

import { loadFeedbackDetail } from './feedback-detail-data';

function fakeDb(row: unknown | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  } as never;
}

describe('loadFeedbackDetail', () => {
  it('returns the full record when the id exists', async () => {
    const db = fakeDb({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: 'Push my environment.',
      email: 'ada@example.com',
      page_url: '/beta',
      user_id: 'user-1',
      app_version: 'web',
      created_at: '2026-10-19T10:00:00Z',
      status: 'new',
      admin_note: null,
      resolved_at: null,
    });

    const result = await loadFeedbackDetail(db, 'f1');

    expect(result).toEqual({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: 'Push my environment.',
      email: 'ada@example.com',
      pageUrl: '/beta',
      userId: 'user-1',
      appVersion: 'web',
      createdAt: '2026-10-19T10:00:00Z',
      status: 'new',
      adminNote: null,
      resolvedAt: null,
    });
  });

  it('returns null when the id does not exist', async () => {
    const db = fakeDb(null);
    const result = await loadFeedbackDetail(db, 'does-not-exist');
    expect(result).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/session', () => ({
  getSessionUser: vi.fn(async () => null),
}));

const insertMock = vi.fn(async (_row: Record<string, unknown>) => ({
  error: null,
}));
vi.mock('../../../lib/supabase', () => ({
  serviceClient: () => ({ from: () => ({ insert: insertMock }) }),
}));

import { POST } from './route';

const req = (body: unknown) =>
  new Request('https://www.memstk.com/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  });

describe('POST /api/feedback', () => {
  it('accepts a valid anonymous submission and inserts a safe row', async () => {
    const res = await POST(
      req({ type: 'idea', message: 'Great tool.', pageUrl: '/beta' }),
    );
    expect(res.status).toBe(202);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row).toMatchObject({
      type: 'idea',
      message: 'Great tool.',
      page_url: '/beta',
      user_id: null,
    });
    expect(row).not.toHaveProperty('localProjectPath');
  });

  it('rejects an invalid body without touching the database', async () => {
    insertMock.mockClear();
    const res = await POST(req({ type: 'nope', message: '' }));
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

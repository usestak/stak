import { describe, expect, it } from 'vitest';

import { loadFeedbackList } from './feedback-data';

function fakeDb(rows: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      const record = (name: string, ...args: unknown[]) => {
        calls.push({ [name]: args });
        return builder;
      };
      builder.select = (...a: unknown[]) => record('select', ...a);
      builder.eq = (...a: unknown[]) => record('eq', ...a);
      builder.in = (...a: unknown[]) => record('in', ...a);
      builder.order = (...a: unknown[]) => record('order', ...a);
      builder.limit = (...a: unknown[]) => record('limit', ...a);
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      return builder;
    },
    __calls: calls,
  } as never;
}

describe('loadFeedbackList', () => {
  it('maps rows to the list shape, newest first, with a message preview', async () => {
    const db = fakeDb([
      {
        id: 'f1',
        type: 'bug',
        message: 'A'.repeat(300),
        email: 'ada@example.com',
        page_url: '/beta',
        app_version: 'web',
        created_at: '2026-10-19T10:00:00Z',
        status: 'new',
        user_id: null,
      },
    ]);

    const result = await loadFeedbackList(db, 'all');

    expect(result).toEqual([
      {
        id: 'f1',
        type: 'bug',
        messagePreview: `${'A'.repeat(140)}…`,
        contact: 'ada@example.com',
        pageUrl: '/beta',
        appVersion: 'web',
        createdAt: '2026-10-19T10:00:00Z',
        status: 'new',
      },
    ]);
  });

  it('does not truncate a short message (no ellipsis added)', async () => {
    const db = fakeDb([
      {
        id: 'f2',
        type: 'idea',
        message: 'Short.',
        email: null,
        page_url: null,
        app_version: null,
        created_at: '2026-10-19T11:00:00Z',
        status: 'new',
        user_id: null,
      },
    ]);
    const result = await loadFeedbackList(db, 'all');
    expect(result[0]!.messagePreview).toBe('Short.');
    expect(result[0]!.contact).toBeNull();
  });

  it('maps the "bugs"/"confusing"/"ideas" filters onto the real `type` column values', async () => {
    const db = fakeDb([]);
    await loadFeedbackList(db, 'bugs');
    const inCall = (db as unknown as { __calls: Record<string, unknown>[] }).__calls.find((c) => 'in' in c);
    expect(inCall).toBeUndefined(); // bugs maps to .eq('type','bug'), not .in()
    const eqCall = (db as unknown as { __calls: Record<string, unknown>[] }).__calls.find(
      (c) => Array.isArray(c.eq) && c.eq[0] === 'type',
    );
    expect(eqCall).toEqual({ eq: ['type', 'bug'] });
  });
});

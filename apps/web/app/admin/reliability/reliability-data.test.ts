import { describe, expect, it } from 'vitest';

import { loadReliabilityMetrics } from './reliability-data';

function fakeDb(rows: { event_name: string; success: boolean; error_code: string | null; user_id: string; created_at: string }[]) {
  return {
    from: () => ({
      select: () => ({
        gte: () => ({
          then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
        }),
      }),
    }),
  } as never;
}

describe('loadReliabilityMetrics', () => {
  it('computes push/pull success rates and groups recent failures', async () => {
    const db = fakeDb([
      { event_name: 'cloud.push.succeeded', success: true, error_code: null, user_id: 'u1', created_at: '2026-10-19T10:00:00Z' },
      { event_name: 'cloud.push.failed', success: false, error_code: 'invalid-request', user_id: 'u1', created_at: '2026-10-19T11:00:00Z' },
      { event_name: 'cloud.push.failed', success: false, error_code: 'invalid-request', user_id: 'u2', created_at: '2026-10-19T12:00:00Z' },
      { event_name: 'cloud.pull.succeeded', success: true, error_code: null, user_id: 'u1', created_at: '2026-10-19T13:00:00Z' },
    ]);

    const result = await loadReliabilityMetrics(db, 'all');

    expect(result.pushSuccessRate).toBeCloseTo(1 / 3);
    expect(result.pullSuccessRate).toBe(1);
    expect(result.recentFailures).toEqual([
      {
        operation: 'cloud.push.failed',
        errorCode: 'invalid-request',
        count: 2,
        affectedUsers: 2,
        firstSeen: '2026-10-19T11:00:00Z',
        lastSeen: '2026-10-19T12:00:00Z',
      },
    ]);
  });

  it('returns null success rates (not NaN) when there are zero attempts of that type', async () => {
    const db = fakeDb([]);
    const result = await loadReliabilityMetrics(db, 'all');
    expect(result.pushSuccessRate).toBeNull();
    expect(result.pullSuccessRate).toBeNull();
    expect(result.recentFailures).toEqual([]);
  });
});

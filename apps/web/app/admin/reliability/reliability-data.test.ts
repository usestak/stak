import { describe, expect, it } from 'vitest';

import { loadReliabilityMetrics } from './reliability-data';

type FailureRow = { event_name: string; error_code: string | null; user_id: string; created_at: string };

function fakeDb(config: { counts: Record<string, number>; failureRows: FailureRow[] }) {
  return {
    from: () => {
      const state: { eventName?: string; isFailureQuery?: boolean } = {};
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, value: unknown) => {
        if (col === 'event_name') state.eventName = value as string;
        if (col === 'success' && value === false) state.isFailureQuery = true;
        return builder;
      };
      builder.gte = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.then = (resolve: (v: unknown) => void) => {
        if (state.isFailureQuery) {
          resolve({ data: config.failureRows, error: null });
        } else {
          resolve({ count: config.counts[state.eventName ?? ''] ?? 0, error: null });
        }
      };
      return builder;
    },
  } as never;
}

describe('loadReliabilityMetrics', () => {
  it('computes push/pull success rates (via head:true counts) and groups recent failures', async () => {
    const db = fakeDb({
      counts: {
        'cloud.push.succeeded': 1,
        'cloud.push.failed': 2,
        'cloud.pull.succeeded': 1,
        'cloud.pull.failed': 0,
      },
      failureRows: [
        { event_name: 'cloud.push.failed', error_code: 'invalid-request', user_id: 'u1', created_at: '2026-10-19T11:00:00Z' },
        { event_name: 'cloud.push.failed', error_code: 'invalid-request', user_id: 'u2', created_at: '2026-10-19T12:00:00Z' },
      ],
    });

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
    const db = fakeDb({ counts: {}, failureRows: [] });
    const result = await loadReliabilityMetrics(db, 'all');
    expect(result.pushSuccessRate).toBeNull();
    expect(result.pullSuccessRate).toBeNull();
    expect(result.recentFailures).toEqual([]);
  });
});

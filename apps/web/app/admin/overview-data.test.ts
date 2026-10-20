import { describe, expect, it } from 'vitest';

import { loadOverviewMetrics } from './overview-data';

function fakeDb(responses: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.gte = chain;
      builder.is = chain;
      builder.not = chain;
      builder.in = chain;
      // Each table's final await resolves to its canned response.
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(responses[table] ?? { count: 0, data: [], error: null });
      return builder;
    },
  } as never;
}

describe('loadOverviewMetrics', () => {
  it('computes totals, activation rate, and portable users from existing tables', async () => {
    const db = fakeDb({
      profiles: { count: 10, data: [], error: null },
      environment_versions: { count: 4, data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
      machines: {
        count: 0,
        data: [
          { user_id: 'u1', machine_id: 'm1' },
          { user_id: 'u1', machine_id: 'm2' },
          { user_id: 'u2', machine_id: 'm3' },
        ],
        error: null,
      },
      feedback: { count: 2, data: [], error: null },
    });

    const result = await loadOverviewMetrics(db, 'all');

    expect(result.totalUsers).toBe(10);
    expect(result.activatedUsers).toBe(2); // distinct users in environment_versions
    expect(result.activationRate).toBe(0.2); // 2 / 10
    expect(result.portableUsers).toBe(1); // only u1 has >=2 distinct machines
    expect(result.pushPullSuccessRate).toBe('unavailable');
  });

  it('returns null activation rate when there are zero total users (avoid divide-by-zero)', async () => {
    const db = fakeDb({
      profiles: { count: 0, data: [], error: null },
      environment_versions: { count: 0, data: [], error: null },
      machines: { count: 0, data: [], error: null },
      feedback: { count: 0, data: [], error: null },
    });

    const result = await loadOverviewMetrics(db, 'all');
    expect(result.activationRate).toBeNull();
  });
});

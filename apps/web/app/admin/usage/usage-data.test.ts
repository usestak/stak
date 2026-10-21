import { describe, expect, it } from 'vitest';

import { loadUsageMetrics } from './usage-data';

function fakeDb(responses: Record<string, { data: unknown[]; count?: number; error?: unknown }>) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.gte = chain;
      builder.eq = chain;
      builder.is = chain;
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(responses[table] ?? { data: [], count: 0, error: null });
      return builder;
    },
  } as never;
}

describe('loadUsageMetrics', () => {
  it('buckets push/pull events per day and counts machines/memory/publications', async () => {
    const db = fakeDb({
      product_events: {
        data: [
          { event_name: 'cloud.push.succeeded', created_at: '2026-10-19T10:00:00Z' },
          { event_name: 'cloud.push.succeeded', created_at: '2026-10-19T11:00:00Z' },
          { event_name: 'cloud.pull.succeeded', created_at: '2026-10-19T12:00:00Z' },
          { event_name: 'memory.recovered', created_at: '2026-10-19T13:00:00Z' },
        ],
        error: null,
      },
      machines: { data: [{ user_id: 'u1', machine_id: 'm1' }], error: null },
      memory_backups: { data: [{ id: 'b1' }], error: null },
      public_stack_versions: { data: [{ id: 'v1' }], error: null },
    });

    const result = await loadUsageMetrics(db, 'all');

    expect(result.pushesPerDay).toEqual([{ date: '2026-10-19', count: 2 }]);
    expect(result.pullsPerDay).toEqual([{ date: '2026-10-19', count: 1 }]);
    expect(result.memoryRecoveriesCount).toBe(1);
    expect(result.activeMachines).toBe(1);
    expect(result.memoryBackupsCount).toBe(1);
    expect(result.publicStakPublications).toBe(1);
  });
});

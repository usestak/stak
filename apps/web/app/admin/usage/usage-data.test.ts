import { describe, expect, it, vi } from 'vitest';

import { loadUsageMetrics } from './usage-data';

function fakeDb(
  responses: Record<
    string,
    { data?: unknown[]; count?: number; error?: unknown }
  >,
) {
  const selectSpies: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      selectSpies[table] = vi.fn(chain);
      builder.select = selectSpies[table];
      builder.gte = chain;
      builder.eq = chain;
      builder.is = chain;
      builder.in = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(responses[table] ?? { data: [], count: 0, error: null });
      return builder;
    },
    __selectSpies: selectSpies,
  } as never;
}

describe('loadUsageMetrics', () => {
  it('buckets push/pull events per day and counts machines/memory/publications', async () => {
    const db = fakeDb({
      product_events: {
        data: [
          {
            event_name: 'cloud.push.succeeded',
            created_at: '2026-10-19T10:00:00Z',
            metadata: null,
          },
          {
            event_name: 'cloud.push.succeeded',
            created_at: '2026-10-19T11:00:00Z',
            metadata: null,
          },
          {
            event_name: 'cloud.pull.succeeded',
            created_at: '2026-10-19T12:00:00Z',
            metadata: null,
          },
          // A replayed push must not be double-counted as a new push.
          {
            event_name: 'cloud.push.succeeded',
            created_at: '2026-10-19T14:00:00Z',
            metadata: { replayed: true },
          },
        ],
        error: null,
      },
      machines: { data: [{ user_id: 'u1', machine_id: 'm1' }], error: null },
      memory_backups: { data: [], count: 1, error: null },
      public_stack_versions: { data: [], count: 1, error: null },
    });

    const result = await loadUsageMetrics(db, 'all');

    expect(result.pushesPerDay).toEqual([{ date: '2026-10-19', count: 2 }]);
    expect(result.pullsPerDay).toEqual([{ date: '2026-10-19', count: 1 }]);
    expect(result.memoryRecoveriesCount).toBe('not-instrumented');
    expect(result.activeMachines).toBe(1);
    expect(result.memoryBackupsCount).toBe(1);
    expect(result.publicStakPublications).toBe(1);
  });

  it('selects the real primary-key column names for memory_backups and public_stack_versions', async () => {
    // Regression guard for a shipped bug: these tables' PKs are backup_id
    // and version_id, NOT 'id' -- selecting 'id' makes PostgREST return an
    // error on every request in production, even though this fake database
    // (keyed by table name, not by column) can't itself catch a wrong
    // column name by returning a failure.
    const db = fakeDb({
      product_events: { data: [], error: null },
      machines: { data: [], error: null },
      memory_backups: { data: [], count: 0, error: null },
      public_stack_versions: { data: [], count: 0, error: null },
    });

    await loadUsageMetrics(db, 'all');

    const spies = (
      db as unknown as {
        __selectSpies: Record<string, ReturnType<typeof vi.fn>>;
      }
    ).__selectSpies;
    expect(spies.memory_backups).toHaveBeenCalledWith('backup_id', {
      count: 'exact',
      head: true,
    });
    expect(spies.public_stack_versions).toHaveBeenCalledWith('version_id', {
      count: 'exact',
      head: true,
    });
  });
});

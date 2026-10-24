import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Final review I2: the unguarded retire (used by Delete Cloud Memory) must only
 * touch COMMITTED rows. Migration 0018's `forbid_memory_backup_mutation`
 * trigger raises on any update of an already-retired row, and protect always
 * leaves retired rows behind — so an unfiltered update made Delete Cloud
 * Memory fail permanently. This fake mirrors that trigger.
 */
type Row = { user_id: string; backup_id: string; state: 'committed' | 'retired' };
const rows: Row[] = [];
const removed: string[] = [];

const updateBuilder = (values: Partial<Row>) => {
  const filters: Array<[keyof Row, string]> = [];
  const run = () => {
    const matched = rows.filter((row) => filters.every(([col, val]) => row[col] === val));
    if (matched.some((row) => row.state !== 'committed'))
      return { error: { message: 'memory_backups are immutable except for retiring a committed generation' } };
    for (const row of matched) Object.assign(row, { state: values.state });
    return { error: null };
  };
  const chain = {
    eq: (col: keyof Row, val: string) => {
      filters.push([col, val]);
      return chain;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return chain;
};

vi.mock('./supabase', () => ({
  serviceClient: () => ({
    from: () => ({ update: (values: Partial<Row>) => updateBuilder(values) }),
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { error: null };
        },
      }),
    },
  }),
}));

const { supabaseRemoteMemoryBackend } = await import('./memory-backend');

beforeEach(() => {
  rows.splice(0);
  removed.splice(0);
});

describe('supabaseRemoteMemoryBackend.retireGeneration (unguarded)', () => {
  it('re-retiring an already-retired row succeeds (no trigger error) and still removes the payload', async () => {
    rows.push({ user_id: 'u1', backup_id: 'b-retired', state: 'retired' });
    const backend = supabaseRemoteMemoryBackend('u1');
    await expect(backend.retireGeneration('b-retired')).resolves.toBeUndefined();
    expect(removed).toEqual(['mem/u1/b-retired']);
  });

  it('retires a committed row', async () => {
    rows.push({ user_id: 'u1', backup_id: 'b-live', state: 'committed' });
    const backend = supabaseRemoteMemoryBackend('u1');
    await backend.retireGeneration('b-live');
    expect(rows[0]?.state).toBe('retired');
    expect(removed).toEqual(['mem/u1/b-live']);
  });
});

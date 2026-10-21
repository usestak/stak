// apps/web/app/admin/system/system-data.test.ts
import { describe, expect, it } from 'vitest';

import { loadSystemStatus } from './system-data';

function fakeDb(opts: { connects: boolean; failureCount: number }) {
  return {
    from: () => ({
      select: () => ({
        limit: () => ({
          then: (resolve: (v: unknown) => void) =>
            opts.connects
              ? resolve({ data: [], error: null })
              : resolve({ data: null, error: { message: 'connection refused' } }),
        }),
        eq: () => ({
          gte: () => ({
            then: (resolve: (v: unknown) => void) =>
              resolve({ count: opts.failureCount, error: null }),
          }),
        }),
      }),
    }),
  } as never;
}

describe('loadSystemStatus', () => {
  it('reports connected and a real failure count when the DB responds', async () => {
    const db = fakeDb({ connects: true, failureCount: 3 });
    const result = await loadSystemStatus(db, '0.1.0', '0.2.0-beta.1');
    expect(result).toEqual({
      webVersion: '0.1.0',
      cliVersion: '0.2.0-beta.1',
      dbConnected: true,
      recentFailureCount: 3,
    });
  });

  it('reports disconnected (not a thrown error) when the connectivity check fails', async () => {
    const db = fakeDb({ connects: false, failureCount: 0 });
    const result = await loadSystemStatus(db, '0.1.0', '0.2.0-beta.1');
    expect(result.dbConnected).toBe(false);
  });
});

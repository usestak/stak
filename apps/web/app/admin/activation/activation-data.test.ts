import { describe, expect, it } from 'vitest';

import { loadActivationFunnel } from './activation-data';

function fakeDb() {
  const data: Record<string, unknown[]> = {
    profiles: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
    cli_tokens: [{ user_id: 'u1' }, { user_id: 'u2' }],
    environment_versions: [{ user_id: 'u1' }],
    machines: [
      { user_id: 'u1', machine_id: 'm1' },
      { user_id: 'u1', machine_id: 'm2' },
    ],
  };
  return {
    from: (table: string) => ({
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        const rows = data[table] ?? [];
        const result = opts?.head
          ? { count: rows.length, data: null, error: null }
          : { count: null, data: rows, error: null };
        const builder: Record<string, unknown> = {};
        builder.is = () => builder;
        builder.then = (resolve: (v: unknown) => void) => resolve(result);
        return builder;
      },
    }),
  } as never;
}

describe('loadActivationFunnel', () => {
  it('counts distinct users at each funnel stage', async () => {
    const result = await loadActivationFunnel(fakeDb());
    expect(result).toEqual({
      accounts: 3,
      cliAuthenticated: 2,
      firstPush: 1,
      portable: 1,
    });
  });

  it('throws when a query returns an error, instead of silently reporting zero', async () => {
    const db = {
      from: () => ({
        select: () => ({
          then: (resolve: (v: unknown) => void) =>
            resolve({ count: null, data: null, error: { message: 'boom' } }),
        }),
      }),
    } as never;
    await expect(loadActivationFunnel(db)).rejects.toBeTruthy();
  });
});

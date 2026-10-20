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
      select: () => ({
        then: (resolve: (v: unknown) => void) => resolve({ data: data[table] ?? [], error: null }),
      }),
    }),
  } as never;
}

describe('loadActivationFunnel', () => {
  it('counts distinct users at each funnel stage', async () => {
    const result = await loadActivationFunnel(fakeDb());
    expect(result).toEqual({ accounts: 3, cliAuthenticated: 2, firstPush: 1, portable: 1 });
  });
});

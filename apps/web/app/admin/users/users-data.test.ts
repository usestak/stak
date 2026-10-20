import { describe, expect, it } from 'vitest';

import { loadUsers } from './users-data';

function fakeDb() {
  const profiles = [
    { user_id: 'u1', display_name: 'Ada', github_username: 'ada', created_at: '2026-01-01T00:00:00Z' },
    { user_id: 'u2', display_name: 'Bo', github_username: 'bo', created_at: '2026-02-01T00:00:00Z' },
  ];
  const versions = [{ user_id: 'u1' }, { user_id: 'u1' }];
  const machines = [{ user_id: 'u1', machine_id: 'm1' }];
  const feedback = [{ user_id: 'u1' }];

  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.ilike = chain;
      builder.then = (resolve: (v: unknown) => void) => {
        const map: Record<string, unknown> = { profiles, environment_versions: versions, machines, feedback };
        resolve({ data: map[table] ?? [], error: null });
      };
      return builder;
    },
  } as never;
}

describe('loadUsers', () => {
  it('joins push/machine/feedback counts onto each profile', async () => {
    const result = await loadUsers(fakeDb());
    expect(result).toEqual([
      { userId: 'u1', displayName: 'Ada', joinedAt: '2026-01-01T00:00:00Z', pushCount: 2, machineCount: 1, feedbackCount: 1 },
      { userId: 'u2', displayName: 'Bo', joinedAt: '2026-02-01T00:00:00Z', pushCount: 0, machineCount: 0, feedbackCount: 0 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { loadUsers } from './users-data';

function fakeDb() {
  const profiles = [
    {
      user_id: 'u1',
      display_name: 'Ada',
      github_username: 'ada',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      user_id: 'u2',
      display_name: 'Bo',
      github_username: 'bo',
      created_at: '2026-02-01T00:00:00Z',
    },
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
      builder.order = chain;
      builder.limit = chain;
      builder.or = chain;
      builder.is = chain;
      builder.then = (resolve: (v: unknown) => void) => {
        const map: Record<string, unknown> = {
          profiles,
          environment_versions: versions,
          machines,
          feedback,
        };
        resolve({ data: map[table] ?? [], error: null });
      };
      return builder;
    },
  } as never;
}

describe('loadUsers', () => {
  it('quotes a search term containing a comma or parenthesis so it cannot break the .or() filter syntax', async () => {
    let capturedOrArg = '';
    const db = {
      from: () => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        builder.select = chain;
        builder.order = chain;
        builder.limit = chain;
        builder.is = chain;
        builder.or = (arg: string) => {
          capturedOrArg = arg;
          return builder;
        };
        builder.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return builder;
      },
    } as never;

    await loadUsers(db, 'a,b(c)');

    // The comma/parens from the search term must be inside double quotes,
    // not sitting at the top level where PostgREST would parse them as
    // filter-string delimiters.
    expect(capturedOrArg).toBe(
      'display_name.ilike."%a,b(c)%",github_username.ilike."%a,b(c)%"',
    );
  });

  it('joins push/machine/feedback counts onto each profile', async () => {
    const result = await loadUsers(fakeDb());
    expect(result).toEqual([
      {
        userId: 'u1',
        displayName: 'Ada',
        joinedAt: '2026-01-01T00:00:00Z',
        pushCount: 2,
        machineCount: 1,
        feedbackCount: 1,
      },
      {
        userId: 'u2',
        displayName: 'Bo',
        joinedAt: '2026-02-01T00:00:00Z',
        pushCount: 0,
        machineCount: 0,
        feedbackCount: 0,
      },
    ]);
  });

  it('throws when a query returns an error, instead of silently reporting zero users', async () => {
    const db = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
    } as never;
    await expect(loadUsers(db)).rejects.toBeTruthy();
  });
});

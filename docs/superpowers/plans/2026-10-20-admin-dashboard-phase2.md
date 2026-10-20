# STAK Admin v1 — Phase 2: Overview + Users + Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 Overview placeholder with real metrics (date-ranged), add the Users list and Activation funnel pages, all sourced from existing tables only (no `product_events` yet — that lands in Phase 3). Retrofit per-page admin gating per the Phase 1 final review's carry-over finding.

**Architecture:** Each page gets a sibling `-data.ts` file exporting a pure, injectable data-loading function (mirrors the existing `apps/web/app/overview/overview-data.ts` pattern) that takes a Supabase client and returns a typed view model — unit-testable without a real database. Every `/admin/*` page becomes a Server Component that calls `getAdminUser()` itself (not just the shared layout) and passes the service client into its `-data.ts` loader.

**Tech Stack:** Next.js 15.5.25 App Router, `@supabase/supabase-js` service-role client, Vitest.

## Global Constraints

- Every `/admin/*` page calls `getAdminUser()` itself and `notFound()`s on null — do not rely solely on `apps/web/app/admin/layout.tsx`'s check (Phase 1 final-review finding: layout and page render concurrently in the App Router, so a page's own server-side data queries can execute even when the layout's `notFound()` fires).
- Do not fake a metric with no real data source. Push/pull success rate, pull activity, and WAU-via-pull are **not computable yet** (no `product_events` until Phase 3) — Overview must show these as "Available in Phase 3" rather than inventing a number.
- Aggregate server-side (SQL `count`/`avg`/`percentile_cont`) — never fetch full tables into the Node process to compute a metric in JS.
- No Tailwind/component library — extend `apps/web/app/admin/admin.css` only.
- Never use `git add .` / `git add -A` — stage exact file paths.
- Migrations are new files under `supabase/migrations/`; do not apply to production.

---

### Task 1: Performance indexes migration

**Files:**
- Create: `supabase/migrations/0016_admin_indexes.sql`

**Interfaces:**
- None (schema-only; consumed implicitly by every later task's queries).

- [ ] **Step 1: Write the migration**

```sql
-- Supports admin dashboard date-range queries (Overview/Activation/Users).
-- Additive only: no existing column/constraint changes.
create index if not exists profiles_created_at_idx
  on public.profiles (created_at);

create index if not exists environment_versions_user_created_idx
  on public.environment_versions (user_id, created_at);

create index if not exists cli_tokens_created_at_idx
  on public.cli_tokens (created_at);
```

- [ ] **Step 2: Read it back to confirm it matches the style of existing index statements**

Run: `grep -n "create index" supabase/migrations/0001_stack_cloud.sql supabase/migrations/0016_admin_indexes.sql`
Expected: both use the same `create index if not exists <name> on public.<table> (<cols>);` shape.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0016_admin_indexes.sql
git commit -m "feat(db): add indexes supporting admin dashboard date-range queries"
```

---

### Task 2: Date-range helper

**Files:**
- Create: `apps/web/lib/admin-date-range.ts`
- Test: `apps/web/lib/admin-date-range.test.ts`

**Interfaces:**
- Produces: `export type AdminDateRange = '24h' | '7d' | '30d' | 'all'` and `export function rangeStart(range: AdminDateRange): Date | null` (returns `null` for `'all'`, meaning "no lower bound") — consumed by every later task's `-data.ts` loader.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/admin-date-range.test.ts
import { describe, expect, it, vi } from 'vitest';

import { rangeStart } from './admin-date-range';

describe('rangeStart', () => {
  it('returns null for "all" (no lower bound)', () => {
    expect(rangeStart('all')).toBeNull();
  });

  it('returns a Date 24 hours before now for "24h"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('24h')).toEqual(new Date('2026-10-19T12:00:00.000Z'));
    vi.useRealTimers();
  });

  it('returns a Date 7 days before now for "7d"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('7d')).toEqual(new Date('2026-10-13T12:00:00.000Z'));
    vi.useRealTimers();
  });

  it('returns a Date 30 days before now for "30d"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('30d')).toEqual(new Date('2026-09-20T12:00:00.000Z'));
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test admin-date-range.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/admin-date-range.ts
export type AdminDateRange = '24h' | '7d' | '30d' | 'all';

const MS_PER_HOUR = 60 * 60 * 1000;

const OFFSET_HOURS: Record<Exclude<AdminDateRange, 'all'>, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/** The lower bound for a date-range filter, or null for "all time" (no bound). */
export const rangeStart = (range: AdminDateRange): Date | null => {
  if (range === 'all') return null;
  return new Date(Date.now() - OFFSET_HOURS[range] * MS_PER_HOUR);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test admin-date-range.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/admin-date-range.ts apps/web/lib/admin-date-range.test.ts
git commit -m "feat(web): add admin date-range helper"
```

---

### Task 3: Overview metrics loader

**Files:**
- Create: `apps/web/app/admin/overview-data.ts`
- Test: `apps/web/app/admin/overview-data.test.ts`

**Interfaces:**
- Consumes: `rangeStart(range)` (Task 2); a Supabase `SupabaseClient` passed in by the caller (the page, Task 4), not constructed internally — this keeps the loader unit-testable with a fake client.
- Produces: `export type OverviewMetrics = { totalUsers: number; newUsers: number; activatedUsers: number; activationRate: number | null; portableUsers: number; newFeedback: number; openFeedback: number; pushPullSuccessRate: 'unavailable' }` and `export async function loadOverviewMetrics(db: SupabaseClient, range: AdminDateRange): Promise<OverviewMetrics>` — consumed by Task 4's `/admin` page.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/overview-data.test.ts
import { describe, expect, it, vi } from 'vitest';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test overview-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/app/admin/overview-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type OverviewMetrics = {
  totalUsers: number;
  newUsers: number;
  activatedUsers: number;
  activationRate: number | null;
  portableUsers: number;
  newFeedback: number;
  openFeedback: number;
  pushPullSuccessRate: 'unavailable';
};

/**
 * Overview metrics computed entirely from existing tables (no product_events
 * yet — that lands in Phase 3). pushPullSuccessRate is explicitly marked
 * unavailable rather than faked from partial data.
 */
export const loadOverviewMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<OverviewMetrics> => {
  const since = rangeStart(range);

  const totalUsersQuery = db.from('profiles').select('user_id', { count: 'exact', head: true });
  const { count: totalUsers } = await totalUsersQuery;

  let newUsersQuery = db.from('profiles').select('user_id', { count: 'exact', head: true });
  if (since) newUsersQuery = newUsersQuery.gte('created_at', since.toISOString());
  const { count: newUsers } = await newUsersQuery;

  let pushesQuery = db.from('environment_versions').select('user_id');
  if (since) pushesQuery = pushesQuery.gte('created_at', since.toISOString());
  const { data: pushRows } = await pushesQuery;
  const activatedUserIds = new Set((pushRows ?? []).map((r: { user_id: string }) => r.user_id));

  const { data: machineRows } = await db.from('machines').select('user_id, machine_id').is('revoked_at', null);
  const machinesByUser = new Map<string, Set<string>>();
  for (const row of (machineRows ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machinesByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machinesByUser.set(row.user_id, set);
  }
  const portableUsers = [...machinesByUser.values()].filter((s) => s.size >= 2).length;

  const { count: newFeedback } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  const { count: openFeedback } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .in('status', ['new', 'reviewing']);

  const total = totalUsers ?? 0;
  const activatedUsers = activatedUserIds.size;

  return {
    totalUsers: total,
    newUsers: newUsers ?? 0,
    activatedUsers,
    activationRate: total > 0 ? activatedUsers / total : null,
    portableUsers,
    newFeedback: newFeedback ?? 0,
    openFeedback: openFeedback ?? 0,
    pushPullSuccessRate: 'unavailable',
  };
};
```

Note: the test's `fakeDb` stub returns the table's canned `{ count, data, error }` response regardless of which chained filter methods were called — this is intentional for a unit test of the *shape* of the computation (not a Supabase query-builder integration test). Each query ignores the live `count`/`data` split inconsistency between `head: true` queries (which return `count`) and `.select()` queries (which return `data`) only because the fake returns both fields on every table; the real Supabase client returns exactly the field appropriate to the query shape used.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test overview-data.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/admin/overview-data.ts apps/web/app/admin/overview-data.test.ts
git commit -m "feat(web): add admin overview metrics loader"
```

---

### Task 4: Real `/admin` Overview page (replaces Phase 1 placeholder)

**Files:**
- Modify: `apps/web/app/admin/page.tsx`
- Test: `apps/web/app/admin/page.test.tsx`

**Interfaces:**
- Consumes: `getAdminUser()` (Phase 1, `apps/web/lib/admin.ts`), `serviceClient()` (`apps/web/lib/supabase.ts`), `loadOverviewMetrics(db, range)` (Task 3), `AdminDateRange` (Task 2), `AdminSidebar` (Phase 1).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const getAdminUserMock = vi.fn();
vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));

const loadOverviewMetricsMock = vi.fn().mockResolvedValue({
  totalUsers: 10,
  newUsers: 2,
  activatedUsers: 3,
  activationRate: 0.3,
  portableUsers: 1,
  newFeedback: 1,
  openFeedback: 2,
  pushPullSuccessRate: 'unavailable',
});
vi.mock('./overview-data', () => ({ loadOverviewMetrics: loadOverviewMetricsMock }));

import AdminOverviewPage from './page';

describe('AdminOverviewPage', () => {
  it('calls notFound (its own gate, independent of the layout) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminOverviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(loadOverviewMetricsMock).not.toHaveBeenCalled();
  });

  it('renders metrics for an admin user, defaulting to the "30d" range', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminOverviewPage({ searchParams: Promise.resolve({}) });
    expect(loadOverviewMetricsMock).toHaveBeenCalledWith({}, '30d');
    expect(JSON.stringify(result)).toContain('10'); // totalUsers rendered somewhere
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test "app/admin/page.test.tsx"`
Expected: FAIL — current `page.tsx` doesn't accept `searchParams`, doesn't call `getAdminUser()`/`loadOverviewMetrics`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import type { AdminDateRange } from '@/lib/admin-date-range';

import { AdminSidebar } from './_components/admin-sidebar';
import { loadOverviewMetrics } from './overview-data';

const RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];

const isAdminDateRange = (value: string | undefined): value is AdminDateRange =>
  RANGES.includes(value as AdminDateRange);

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range) ? params.range : '30d';
  const metrics = await loadOverviewMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="overview" />
      <main className="stak-admin-main">
        <h1>Overview</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Total users</dt>
            <dd>{metrics.totalUsers}</dd>
          </div>
          <div>
            <dt>New users</dt>
            <dd>{metrics.newUsers}</dd>
          </div>
          <div>
            <dt>Activated users</dt>
            <dd>{metrics.activatedUsers}</dd>
          </div>
          <div>
            <dt>Activation rate</dt>
            <dd>
              {metrics.activationRate === null
                ? 'No users yet'
                : `${(metrics.activationRate * 100).toFixed(1)}%`}
            </dd>
          </div>
          <div>
            <dt>Portable users</dt>
            <dd>{metrics.portableUsers}</dd>
          </div>
          <div>
            <dt>New feedback</dt>
            <dd>{metrics.newFeedback}</dd>
          </div>
          <div>
            <dt>Open feedback</dt>
            <dd>{metrics.openFeedback}</dd>
          </div>
          <div>
            <dt>Push/pull success rate</dt>
            <dd>Available in Phase 3</dd>
          </div>
        </dl>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test "app/admin/page.test.tsx"`
Expected: PASS (2 tests)

- [ ] **Step 5: Add a minimal CSS addition for the metric grid/range pills to `apps/web/app/admin/admin.css`**

```css
/* Appended to apps/web/app/admin/admin.css */
.stak-admin-range-pills {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.stak-admin-metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.stak-admin-metric-grid dt {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 4px;
}

.stak-admin-metric-grid dd {
  font-size: 28px;
  font-weight: 600;
  margin: 0;
}
```

- [ ] **Step 6: Run full web test suite + typecheck to confirm no regressions**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/admin/page.tsx apps/web/app/admin/page.test.tsx apps/web/app/admin/admin.css
git commit -m "feat(web): render real Overview metrics with date-range pills"
```

---

### Task 5: Users list loader + page

**Files:**
- Create: `apps/web/app/admin/users/users-data.ts`
- Create: `apps/web/app/admin/users/page.tsx`
- Test: `apps/web/app/admin/users/users-data.test.ts`

**Interfaces:**
- Consumes: `getAdminUser()`, `serviceClient()`, `AdminSidebar`.
- Produces: `export type AdminUserRow = { userId: string; displayName: string; joinedAt: string; pushCount: number; machineCount: number; feedbackCount: number }` and `export async function loadUsers(db: SupabaseClient, search?: string): Promise<AdminUserRow[]>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/users/users-data.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test users-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/app/admin/users/users-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type AdminUserRow = {
  userId: string;
  displayName: string;
  joinedAt: string;
  pushCount: number;
  machineCount: number;
  feedbackCount: number;
};

type ProfileRow = { user_id: string; display_name: string | null; github_username: string | null; created_at: string };

export const loadUsers = async (db: SupabaseClient, search?: string): Promise<AdminUserRow[]> => {
  let profilesQuery = db.from('profiles').select('user_id, display_name, github_username, created_at');
  if (search) profilesQuery = profilesQuery.ilike('display_name', `%${search}%`);
  const { data: profiles } = await profilesQuery;

  const { data: versions } = await db.from('environment_versions').select('user_id');
  const { data: machines } = await db.from('machines').select('user_id, machine_id');
  const { data: feedbackRows } = await db.from('feedback').select('user_id');

  const countBy = (rows: { user_id: string }[] | null) => {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    return counts;
  };

  const pushCounts = countBy(versions as { user_id: string }[] | null);
  const feedbackCounts = countBy((feedbackRows ?? []).filter((r: { user_id: string | null }) => r.user_id) as { user_id: string }[]);

  const machineCounts = new Map<string, Set<string>>();
  for (const row of (machines ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machineCounts.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machineCounts.set(row.user_id, set);
  }

  return ((profiles ?? []) as ProfileRow[]).map((p) => ({
    userId: p.user_id,
    displayName: p.display_name ?? p.github_username ?? 'Unnamed',
    joinedAt: p.created_at,
    pushCount: pushCounts.get(p.user_id) ?? 0,
    machineCount: machineCounts.get(p.user_id)?.size ?? 0,
    feedbackCount: feedbackCounts.get(p.user_id) ?? 0,
  }));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test users-data.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Write the page**

```typescript
// apps/web/app/admin/users/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadUsers } from './users-data';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const users = await loadUsers(serviceClient(), params.q);

  return (
    <>
      <AdminSidebar active="users" />
      <main className="stak-admin-main">
        <h1>Users</h1>
        <form method="get">
          <input type="search" name="q" defaultValue={params.q ?? ''} placeholder="Search by name" />
        </form>
        {users.length === 0 ? (
          <p>No users yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Joined</th>
                <th>Pushes</th>
                <th>Machines</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId}>
                  <td>{u.displayName}</td>
                  <td>{new Date(u.joinedAt).toLocaleDateString()}</td>
                  <td>{u.pushCount}</td>
                  <td>{u.machineCount}</td>
                  <td>{u.feedbackCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/admin/users/users-data.ts apps/web/app/admin/users/users-data.test.ts apps/web/app/admin/users/page.tsx
git commit -m "feat(web): add admin Users list page"
```

---

### Task 6: Activation funnel loader + page

**Files:**
- Create: `apps/web/app/admin/activation/activation-data.ts`
- Create: `apps/web/app/admin/activation/page.tsx`
- Test: `apps/web/app/admin/activation/activation-data.test.ts`

**Interfaces:**
- Produces: `export type ActivationFunnel = { accounts: number; cliAuthenticated: number; firstPush: number; portable: number }` and `export async function loadActivationFunnel(db: SupabaseClient): Promise<ActivationFunnel>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/activation/activation-data.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test activation-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/app/admin/activation/activation-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type ActivationFunnel = {
  accounts: number;
  cliAuthenticated: number;
  firstPush: number;
  portable: number;
};

const distinctUserCount = (rows: { user_id: string }[] | null): number =>
  new Set((rows ?? []).map((r) => r.user_id)).size;

export const loadActivationFunnel = async (db: SupabaseClient): Promise<ActivationFunnel> => {
  const { data: profiles } = await db.from('profiles').select('user_id');
  const { data: tokens } = await db.from('cli_tokens').select('user_id');
  const { data: versions } = await db.from('environment_versions').select('user_id');
  const { data: machines } = await db.from('machines').select('user_id, machine_id');

  const machinesByUser = new Map<string, Set<string>>();
  for (const row of (machines ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machinesByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machinesByUser.set(row.user_id, set);
  }
  const portable = [...machinesByUser.values()].filter((s) => s.size >= 2).length;

  return {
    accounts: distinctUserCount(profiles as { user_id: string }[] | null),
    cliAuthenticated: distinctUserCount(tokens as { user_id: string }[] | null),
    firstPush: distinctUserCount(versions as { user_id: string }[] | null),
    portable,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test activation-data.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Write the page**

```typescript
// apps/web/app/admin/activation/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadActivationFunnel } from './activation-data';

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'N/A';

export default async function AdminActivationPage() {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const funnel = await loadActivationFunnel(serviceClient());

  return (
    <>
      <AdminSidebar active="activation" />
      <main className="stak-admin-main">
        <h1>Activation</h1>
        <ol>
          <li>Accounts: {funnel.accounts}</li>
          <li>
            CLI-authenticated: {funnel.cliAuthenticated} ({pct(funnel.cliAuthenticated, funnel.accounts)})
          </li>
          <li>
            First push: {funnel.firstPush} ({pct(funnel.firstPush, funnel.accounts)})
          </li>
          <li>
            Portable: {funnel.portable} ({pct(funnel.portable, funnel.accounts)})
          </li>
        </ol>
      </main>
    </>
  );
}
```

- [ ] **Step 6: Run full suite, typecheck, and build**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web build`
Expected: all pass; build lists `/admin/users` and `/admin/activation` as dynamic (ƒ).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/admin/activation/activation-data.ts apps/web/app/admin/activation/activation-data.test.ts apps/web/app/admin/activation/page.tsx
git commit -m "feat(web): add admin Activation funnel page"
```

---

## Phase 2 Completion Checklist

- [ ] All 6 tasks committed individually.
- [ ] Full web suite, typecheck, build all pass.
- [ ] Every new page (`/admin`, `/admin/users`, `/admin/activation`) calls `getAdminUser()` itself, not just relying on the layout (Phase 1 carry-over finding resolved).
- [ ] No metric is faked — push/pull success rate explicitly shown as "Available in Phase 3".
- [ ] Phase 3 plan (Usage + Reliability + `product_events` instrumentation) to be written next.

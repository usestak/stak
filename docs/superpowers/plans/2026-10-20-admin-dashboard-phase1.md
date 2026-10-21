# STAK Admin v1 — Phase 1: Auth Model + Schema + Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the permanent admin authorization model (`admin_users` table + `getAdminUser()` server helper), the `/admin` page shell with gated navigation, and the security tests proving non-admins cannot reach admin pages or leak the service-role client into the browser bundle.

**Architecture:** New `public.admin_users` table (service-role-only, RLS enabled, no policies) mirrors the existing `feedback` table's security posture. `apps/web/lib/admin.ts` exposes `getAdminUser()`, which layers an `admin_users` lookup on top of the existing `getSessionUser()`. Every `/admin/*` page is a Server Component that calls it first and `notFound()`s otherwise — same shape as `overview/page.tsx`'s `redirect()`-on-null pattern, just returning 404 instead of revealing the route exists. A new `AdminSidebar` + `admin.css` extend the existing `.stak` dark theme.

**Tech Stack:** Next.js 15.5.25 App Router, Supabase (`@supabase/supabase-js` service-role client via `serviceClient()`), Vitest + React Testing Library (jsdom), plain scoped CSS (no Tailwind).

## Global Constraints

- Do not publish npm. Do not version-bump the CLI. Do not redesign CLI semantics.
- Never hardcode admin email addresses in frontend code; never trust a client-side boolean for admin gating.
- The service-role key must never reach the browser.
- Enable RLS on `admin_users`; no public policies.
- Admin pages/routes: 404 (not redirect) for unauthorized access — don't reveal the route exists.
- Admin nav must never appear in the public site nav; admin pages must be non-indexed, non-cached (`dynamic = 'force-dynamic'`, `robots: { index: false, follow: false }`).
- No `git add .` / `git add -A` — stage files by exact path.
- Migrations are new files under `supabase/migrations/`; do not mutate production schema directly — hand back the apply procedure at the end.

---

### Task 1: `admin_users` migration

**Files:**
- Create: `supabase/migrations/0013_admin_users.sql`

**Interfaces:**
- Produces: table `public.admin_users(user_id uuid PK, role text, created_at timestamptz)` — consumed by Task 3's `getAdminUser()`.

- [ ] **Step 1: Write the migration file**

```sql
-- Permanent admin authorization. Mirrors public.feedback's security posture
-- (0012_feedback.sql): RLS enabled with NO policies, so anon/authenticated
-- PostgREST callers can neither insert nor select. The only read path is
-- apps/web/lib/admin.ts's getAdminUser(), which uses the service-role client
-- after the caller's identity has already been derived from a verified
-- Supabase session (getSessionUser()). This is defense-in-depth, not the
-- enforcement point.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
-- No policies: reads/writes only via the service-role client in server code.
```

- [ ] **Step 2: Verify SQL syntax locally**

Run: `cat supabase/migrations/0013_admin_users.sql` and visually confirm it matches `0012_feedback.sql`'s structure (no automated linter for raw SQL in this repo — this is a read-back check, not an apply).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0013_admin_users.sql
git commit -m "feat(db): add admin_users table for admin authorization"
```

---

### Task 2: `cloudEnv`/`serviceClient` — confirm reuse, no changes needed

**Files:**
- None (verification-only task; `apps/web/lib/supabase.ts`'s `serviceClient()` and `apps/web/lib/session.ts`'s `getSessionUser()` are reused as-is).

**Interfaces:**
- Consumes: `serviceClient(): SupabaseClient` from `apps/web/lib/supabase.ts`; `getSessionUser(): Promise<WebUser | null>` from `apps/web/lib/session.ts`.

- [ ] **Step 1: Confirm both exports exist with these exact signatures**

Run: `grep -n "export const serviceClient" apps/web/lib/supabase.ts && grep -n "export const getSessionUser" apps/web/lib/session.ts`
Expected: both lines found, matching the signatures above.

No commit — this task only confirms the interfaces Task 3 depends on.

---

### Task 3: `getAdminUser()` server helper

**Files:**
- Create: `apps/web/lib/admin.ts`
- Test: `apps/web/lib/admin.test.ts`

**Interfaces:**
- Consumes: `getSessionUser()` (Task 2), `serviceClient()` (Task 2).
- Produces: `export type AdminUser = WebUser & { role: 'owner' | 'admin' }` and `export async function getAdminUser(): Promise<AdminUser | null>` — consumed by Task 5 (admin shell), Task 6 (security tests), and every later-phase admin page/route.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/admin.test.ts
import { describe, expect, it, vi } from 'vitest';

const getSessionUserMock = vi.fn();
const fromMock = vi.fn();

vi.mock('./session', () => ({
  getSessionUser: getSessionUserMock,
}));

vi.mock('./supabase', () => ({
  serviceClient: () => ({ from: fromMock }),
}));

import { getAdminUser } from './admin';

describe('getAdminUser', () => {
  it('returns null when there is no signed-in session', async () => {
    getSessionUserMock.mockResolvedValue(null);
    const result = await getAdminUser();
    expect(result).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns null when the signed-in user is not in admin_users', async () => {
    getSessionUserMock.mockResolvedValue({ id: 'user-1', displayName: 'Ada' });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const result = await getAdminUser();
    expect(result).toBeNull();
    expect(fromMock).toHaveBeenCalledWith('admin_users');
    expect(select).toHaveBeenCalledWith('role');
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns the admin user with role when present in admin_users', async () => {
    getSessionUserMock.mockResolvedValue({ id: 'user-1', displayName: 'Ada' });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { role: 'owner' }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const result = await getAdminUser();
    expect(result).toEqual({ id: 'user-1', displayName: 'Ada', role: 'owner' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test admin.test.ts`
Expected: FAIL — `admin.ts` does not exist yet (`Failed to resolve import "./admin"`).

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/admin.ts
import { getSessionUser, type WebUser } from './session';
import { serviceClient } from './supabase';

export type AdminRole = 'owner' | 'admin';
export type AdminUser = WebUser & { role: AdminRole };

/**
 * Resolve the signed-in user AND verify admin membership server-side.
 * Returns null for a logged-out visitor, a logged-in non-admin, or any
 * lookup failure — callers must treat null as "no admin access" in every
 * case, never distinguish the reasons.
 */
export const getAdminUser = async (): Promise<AdminUser | null> => {
  const user = await getSessionUser();
  if (!user) return null;

  const { data, error } = await serviceClient()
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return null;

  return { ...user, role: data.role as AdminRole };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test admin.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/admin.ts apps/web/lib/admin.test.ts
git commit -m "feat(web): add getAdminUser server-side admin authorization helper"
```

---

### Task 4: Admin shell CSS (extend `.stak` theme)

**Files:**
- Create: `apps/web/app/admin/admin.css`

**Interfaces:**
- Produces: CSS classes `.stak-admin`, `.stak-admin-sidebar`, `.stak-admin-nav-link`, `.stak-admin-nav-link.is-active`, `.stak-admin-main` — consumed by Task 5's `AdminSidebar` and all later-phase admin pages.

- [ ] **Step 1: Read the existing theme tokens to reuse verbatim**

Run: `sed -n '1,40p' apps/web/app/overview/shell.css`
Expected: see `--bg:#121211`, `--panel:#0e0e0d`, `--ink:#edeae3`, `--line`, `--chip:#34332f`, `--orange:#ee7a3b`, status colors — confirm exact values before writing Step 2 (copy them, don't guess).

- [ ] **Step 2: Write the CSS file**

```css
/* apps/web/app/admin/admin.css
 * Extends the existing .stak dark instrument-panel theme (see
 * app/overview/shell.css) for the internal admin surface. Reuses the same
 * token values so the admin dashboard reads as the same product, not a
 * bolted-on tool.
 */
.stak-admin {
  --bg: #121211;
  --panel: #0e0e0d;
  --ink: #edeae3;
  --muted: #a19d94;
  --line: #242320;
  --chip: #34332f;
  --orange: #ee7a3b;
  --green: #84cb8e;
  --amber: #e5b85c;
  --red: #e5776a;

  display: flex;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
}

.stak-admin-sidebar {
  width: 216px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--line);
  padding: 24px 16px;
}

.stak-admin-nav-link {
  display: block;
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  color: var(--muted);
  text-decoration: none;
  font-size: 14px;
}

.stak-admin-nav-link.is-active {
  background: var(--chip);
  color: var(--ink);
}

.stak-admin-nav-link:hover {
  color: var(--ink);
}

.stak-admin-main {
  flex: 1;
  padding: 32px;
  min-width: 0;
}

@media (max-width: 768px) {
  .stak-admin {
    flex-direction: column;
  }

  .stak-admin-sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/admin.css
git commit -m "feat(web): add admin dashboard shell CSS extending the .stak theme"
```

---

### Task 5: Admin shell layout + sidebar component + gated `/admin` landing page

**Files:**
- Create: `apps/web/app/admin/_components/admin-sidebar.tsx`
- Create: `apps/web/app/admin/layout.tsx`
- Create: `apps/web/app/admin/page.tsx`
- Test: `apps/web/app/admin/_components/admin-sidebar.test.tsx`

**Interfaces:**
- Consumes: `getAdminUser()` (Task 3), `.stak-admin*` classes (Task 4).
- Produces: `AdminSidebar({ active }: { active: AdminNavKey })` component and `AdminNavKey` type — consumed by every later-phase admin page (`/admin/users`, `/admin/activation`, etc., which each import `AdminSidebar` and pass their own `active` key).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/_components/admin-sidebar.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminSidebar } from './admin-sidebar';

describe('AdminSidebar', () => {
  it('renders all seven nav links with the active one marked', () => {
    render(<AdminSidebar active="overview" />);
    const overviewLink = screen.getByRole('link', { name: 'Overview' });
    expect(overviewLink).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'Users' })).not.toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: 'Activation' })).toHaveAttribute('href', '/admin/activation');
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/admin/usage');
    expect(screen.getByRole('link', { name: 'Reliability' })).toHaveAttribute('href', '/admin/reliability');
    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute('href', '/admin/feedback');
    expect(screen.getByRole('link', { name: 'System' })).toHaveAttribute('href', '/admin/system');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test admin-sidebar.test.tsx`
Expected: FAIL — `admin-sidebar.tsx` does not exist.

- [ ] **Step 3: Write the sidebar component**

```typescript
// apps/web/app/admin/_components/admin-sidebar.tsx
import Link from 'next/link';

export type AdminNavKey =
  | 'overview'
  | 'users'
  | 'activation'
  | 'usage'
  | 'reliability'
  | 'feedback'
  | 'system';

const NAV: { key: AdminNavKey; label: string; href: string }[] = [
  { key: 'overview', label: 'Overview', href: '/admin' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'activation', label: 'Activation', href: '/admin/activation' },
  { key: 'usage', label: 'Usage', href: '/admin/usage' },
  { key: 'reliability', label: 'Reliability', href: '/admin/reliability' },
  { key: 'feedback', label: 'Feedback', href: '/admin/feedback' },
  { key: 'system', label: 'System', href: '/admin/system' },
];

export function AdminSidebar({ active }: { active: AdminNavKey }) {
  return (
    <nav className="stak-admin-sidebar" aria-label="Admin navigation">
      {NAV.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={`stak-admin-nav-link${item.key === active ? ' is-active' : ''}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test admin-sidebar.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 5: Write the admin layout (gate + chrome, shared by every `/admin/*` page)**

```typescript
// apps/web/app/admin/layout.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';

import './admin.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  return <div className="stak-admin">{children}</div>;
}
```

- [ ] **Step 6: Write the `/admin` landing page (Overview placeholder for Phase 1)**

```typescript
// apps/web/app/admin/page.tsx
import { AdminSidebar } from './_components/admin-sidebar';

export default function AdminOverviewPage() {
  return (
    <>
      <AdminSidebar active="overview" />
      <main className="stak-admin-main">
        <h1>Overview</h1>
        <p>Metrics land in Phase 2.</p>
      </main>
    </>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/admin/_components/admin-sidebar.tsx apps/web/app/admin/_components/admin-sidebar.test.tsx apps/web/app/admin/layout.tsx apps/web/app/admin/page.tsx
git commit -m "feat(web): add gated admin shell layout, sidebar, and overview placeholder"
```

---

### Task 6: Security tests A, B, C, D, I

**Files:**
- Test: `apps/web/app/admin/admin-access.test.tsx`

**Interfaces:**
- Consumes: `getAdminUser()` (Task 3), `AdminLayout` (Task 5).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/app/admin/admin-access.test.tsx
import { describe, expect, it, vi } from 'vitest';

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

const getAdminUserMock = vi.fn();
vi.mock('@/lib/admin', () => ({
  getAdminUser: getAdminUserMock,
}));

import AdminLayout from './layout';

describe('admin access control', () => {
  it('A: anonymous visitor (no session) cannot reach /admin — notFound is called', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('B: authenticated non-admin user cannot reach /admin — notFound is called', async () => {
    // getAdminUser() itself returns null for a signed-in non-admin (verified
    // in admin.test.ts); the layout has no separate branch for this case, so
    // the same assertion as A covers it at this boundary.
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('C: admin user can access — layout renders children without calling notFound', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminLayout({ children: <div data-testid="child" /> });
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
```

Note: tests D (admin data endpoints reject non-admins) and the feedback-specific E–H land in Phase 4 alongside the feedback workflow routes they protect — there are no admin data mutation endpoints yet in Phase 1 to test. Record this explicitly rather than faking a route.

- [ ] **Step 2: Run test to verify it fails first (TDD check)**

Run: `pnpm --filter @stack/web test admin-access.test.tsx`
Expected: if `layout.tsx` from Task 5 is already committed, these should PASS immediately (the layout was already built test-first in Task 5's sense via the sidebar test, but this file is new coverage). Run once with the mock returning `undefined` from `getAdminUserMock` (no `mockResolvedValue` call) first to confirm the test harness actually fails when the mock is misconfigured — e.g. temporarily change line `getAdminUserMock.mockResolvedValue(null)` in test A to `getAdminUserMock.mockResolvedValue({ id: 'x', role: 'owner' })` and confirm it FAILS, then revert. This proves the test isn't vacuously passing.

- [ ] **Step 3: Revert the temporary change and run the full suite to verify it passes**

Run: `pnpm --filter @stack/web test admin-access.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 4: Static check for test I (service-role/admin logic never ships client-side)**

Run: `grep -rn "'use client'" apps/web/lib/admin.ts apps/web/lib/supabase.ts apps/web/app/admin/layout.tsx`
Expected: no matches (none of these files should ever contain a `'use client'` directive). This is the concrete check for security test I — record the command and its expected empty output as the permanent regression check (it can be wired into CI later; for now it's a documented manual gate run in Step 5 alongside build).

- [ ] **Step 5: Run full web test suite + typecheck + build to confirm no regressions**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web build`
Expected: all three succeed; build output confirms `/admin` is present and dynamic (not statically prerendered).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/admin/admin-access.test.tsx
git commit -m "test(web): add admin access-control tests A, B, C and static service-role isolation check (I)"
```

---

### Task 7: Owner bootstrap procedure (documentation, no production mutation)

**Files:**
- Create: `docs/admin-bootstrap.md`

**Interfaces:**
- None (documentation task).

- [ ] **Step 1: Write the bootstrap doc**

```markdown
# STAK Admin — Owner Bootstrap

One-time production setup to grant the first `owner` admin account. Do not
run this automatically — a human runs it after confirming the signed-in
GitHub account to grant.

1. Apply pending migrations to production (manual step, same convention as
   every prior migration):
   - `supabase/migrations/0013_admin_users.sql`
   - Via Supabase Dashboard → SQL Editor (paste and run), or
     `supabase db push` from the repo root if the CLI is linked to the
     production project.

2. Find your Supabase Auth user UUID:
   - Supabase Dashboard → Authentication → Users → locate your account by
     email/GitHub username → copy the `UID` column value.

3. Insert yourself as owner (SQL Editor):

   ```sql
   insert into public.admin_users (user_id, role)
   values ('<your-uuid-here>', 'owner');
   ```

4. Sign in to the web app with that account and visit `/admin` — it should
   render the Overview placeholder instead of 404.
```

- [ ] **Step 2: Commit**

```bash
git add docs/admin-bootstrap.md
git commit -m "docs: add admin owner bootstrap procedure"
```

---

## Phase 1 Completion Checklist

- [ ] All 7 tasks committed individually (no squashing, no `git add .`).
- [ ] `pnpm --filter @stack/web test`, `typecheck`, `lint`, and `build` all pass.
- [ ] Migration `0013_admin_users.sql` exists in the repo but has NOT been applied to production by this plan — apply procedure handed to the user via `docs/admin-bootstrap.md`.
- [ ] `/admin` 404s for anonymous and non-admin sessions (Task 6), renders for admins (Task 6), and no admin/service-role logic appears in any `'use client'` file (Task 6 Step 4).
- [ ] Phase 2 plan (Overview real metrics + Users + Activation) to be written next, now that the shell and auth gate exist.

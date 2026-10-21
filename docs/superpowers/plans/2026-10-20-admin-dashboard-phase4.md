# STAK Admin v1 — Phase 4: Feedback Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `public.feedback` (already has its admin workflow columns — `status`/`admin_note`/`resolved_at`/`resolved_by` — from the Phase 2 fix commit) into the permanent admin inbox: a filterable list, a detail view, and a status/note workflow, plus the feedback-specific security tests (E–H) from the design spec.

**Architecture:** List/detail pages follow the exact pattern established in Phases 1–3 — a `-data.ts` loader taking an injected Supabase client, a Server Component page that independently calls `getAdminUser()`/`notFound()` before any fetch. The mutation (status/note update) is a new Route Handler (`PATCH /api/admin/feedback/[id]`), mirroring the existing `apps/web/app/api/feedback/route.ts`'s structure and test style — it re-verifies `getAdminUser()` itself (never trusting that the page that linked to it was gated), since a data endpoint must independently enforce authorization per the design spec.

**Tech Stack:** Next.js 15 App Router, `@supabase/supabase-js`, Vitest.

## Global Constraints

- The `PATCH /api/admin/feedback/[id]` route handler must call `getAdminUser()` itself and return 404 (not 401/403) for a non-admin, consistent with every other admin boundary in this project not revealing that the resource exists to an unauthorized caller.
- Admin notes must never be exposed on any public page or public API — this phase only adds admin-surface code; it must not touch `apps/web/app/feedback/` (the public submission form) or `apps/web/app/api/feedback/route.ts` (the public submission endpoint).
- Never use `git add .` / `git add -A` — stage exact file paths.
- No new migration needed — workflow columns already exist (`supabase/migrations/0014_feedback_workflow.sql`).
- Status values are exactly `'new' | 'reviewing' | 'resolved' | 'archived'` (the migration's check constraint) — validate against this closed set before writing, don't trust the client body blindly.

---

### Task 1: Feedback list loader + page

**Files:**
- Create: `apps/web/app/admin/feedback/feedback-data.ts`
- Create: `apps/web/app/admin/feedback/page.tsx`
- Test: `apps/web/app/admin/feedback/feedback-data.test.ts`

**Interfaces:**
- Consumes: `getAdminUser()`, `serviceClient()`, `AdminSidebar` (AdminNavKey already includes `'feedback'`).
- Produces: `export type FeedbackFilter = 'all' | 'new' | 'bugs' | 'confusing' | 'ideas' | 'resolved'`, `export type FeedbackListRow = { id: string; type: string; messagePreview: string; contact: string | null; pageUrl: string | null; appVersion: string | null; createdAt: string; status: string }`, `export async function loadFeedbackList(db: SupabaseClient, filter: FeedbackFilter): Promise<FeedbackListRow[]>` — consumed by Task 2's detail page link structure (no shared types beyond the row shape).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/feedback/feedback-data.test.ts
import { describe, expect, it } from 'vitest';

import { loadFeedbackList } from './feedback-data';

function fakeDb(rows: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      const record = (name: string, ...args: unknown[]) => {
        calls.push({ [name]: args });
        return builder;
      };
      builder.select = (...a: unknown[]) => record('select', ...a);
      builder.eq = (...a: unknown[]) => record('eq', ...a);
      builder.in = (...a: unknown[]) => record('in', ...a);
      builder.order = (...a: unknown[]) => record('order', ...a);
      builder.limit = (...a: unknown[]) => record('limit', ...a);
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      return builder;
    },
    __calls: calls,
  } as never;
}

describe('loadFeedbackList', () => {
  it('maps rows to the list shape, newest first, with a message preview', async () => {
    const db = fakeDb([
      {
        id: 'f1',
        type: 'bug',
        message: 'A'.repeat(300),
        email: 'ada@example.com',
        page_url: '/beta',
        app_version: 'web',
        created_at: '2026-10-19T10:00:00Z',
        status: 'new',
        user_id: null,
      },
    ]);

    const result = await loadFeedbackList(db, 'all');

    expect(result).toEqual([
      {
        id: 'f1',
        type: 'bug',
        messagePreview: `${'A'.repeat(140)}…`,
        contact: 'ada@example.com',
        pageUrl: '/beta',
        appVersion: 'web',
        createdAt: '2026-10-19T10:00:00Z',
        status: 'new',
      },
    ]);
  });

  it('does not truncate a short message (no ellipsis added)', async () => {
    const db = fakeDb([
      {
        id: 'f2',
        type: 'idea',
        message: 'Short.',
        email: null,
        page_url: null,
        app_version: null,
        created_at: '2026-10-19T11:00:00Z',
        status: 'new',
        user_id: null,
      },
    ]);
    const result = await loadFeedbackList(db, 'all');
    expect(result[0]!.messagePreview).toBe('Short.');
    expect(result[0]!.contact).toBeNull();
  });

  it('maps the "bugs"/"confusing"/"ideas" filters onto the real `type` column values', async () => {
    const db = fakeDb([]);
    await loadFeedbackList(db, 'bugs');
    const inCall = (db as unknown as { __calls: Record<string, unknown>[] }).__calls.find((c) => 'in' in c);
    expect(inCall).toBeUndefined(); // bugs maps to .eq('type','bug'), not .in()
    const eqCall = (db as unknown as { __calls: Record<string, unknown>[] }).__calls.find(
      (c) => Array.isArray(c.eq) && c.eq[0] === 'type',
    );
    expect(eqCall).toEqual({ eq: ['type', 'bug'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test feedback-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/feedback/feedback-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackFilter = 'all' | 'new' | 'bugs' | 'confusing' | 'ideas' | 'resolved';

export type FeedbackListRow = {
  id: string;
  type: string;
  messagePreview: string;
  contact: string | null;
  pageUrl: string | null;
  appVersion: string | null;
  createdAt: string;
  status: string;
};

const PREVIEW_LENGTH = 140;

const previewOf = (message: string): string =>
  message.length > PREVIEW_LENGTH ? `${message.slice(0, PREVIEW_LENGTH)}…` : message;

type FeedbackRow = {
  id: string;
  type: string;
  message: string;
  email: string | null;
  page_url: string | null;
  app_version: string | null;
  created_at: string;
  status: string;
};

// Row cap pending a proper paginated UI -- same accepted-exception category
// as every other admin list in this project (Phase 2/3 final reviews), and
// subject to the same real PostgREST 1000-row response cap regardless of
// this value.
const MAX_ROWS = 500;

export const loadFeedbackList = async (
  db: SupabaseClient,
  filter: FeedbackFilter,
): Promise<FeedbackListRow[]> => {
  let query = db
    .from('feedback')
    .select('id, type, message, email, page_url, app_version, created_at, status')
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (filter === 'new') query = query.eq('status', 'new');
  else if (filter === 'resolved') query = query.eq('status', 'resolved');
  else if (filter === 'bugs') query = query.eq('type', 'bug');
  else if (filter === 'confusing') query = query.eq('type', 'confusing');
  else if (filter === 'ideas') query = query.eq('type', 'idea');

  const { data, error } = await query;
  if (error) throw error;

  return ((data ?? []) as FeedbackRow[]).map((row) => ({
    id: row.id,
    type: row.type,
    messagePreview: previewOf(row.message),
    contact: row.email,
    pageUrl: row.page_url,
    appVersion: row.app_version,
    createdAt: row.created_at,
    status: row.status,
  }));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test feedback-data.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the list page**

```typescript
// apps/web/app/admin/feedback/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadFeedbackList, type FeedbackFilter } from './feedback-data';

const FILTERS: FeedbackFilter[] = ['all', 'new', 'bugs', 'confusing', 'ideas', 'resolved'];

const isFeedbackFilter = (value: string | undefined): value is FeedbackFilter =>
  FILTERS.includes(value as FeedbackFilter);

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const filter: FeedbackFilter = isFeedbackFilter(params.filter) ? params.filter : 'all';
  const items = await loadFeedbackList(serviceClient(), filter);

  return (
    <>
      <AdminSidebar active="feedback" />
      <main className="stak-admin-main">
        <h1>Feedback</h1>
        <nav aria-label="Filter" className="stak-admin-range-pills">
          {FILTERS.map((f) => (
            <a
              key={f}
              href={`/admin/feedback?filter=${f}`}
              className={`stak-admin-nav-link${f === filter ? ' is-active' : ''}`}
            >
              {f}
            </a>
          ))}
        </nav>
        {items.length === 0 ? (
          <p>No feedback yet.</p>
        ) : (
          <div className="stak-admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Message</th>
                  <th>Contact</th>
                  <th>Source page</th>
                  <th>Version</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.type}</td>
                    <td>
                      <Link href={`/admin/feedback/${item.id}`}>{item.messagePreview}</Link>
                    </td>
                    <td>{item.contact ?? '—'}</td>
                    <td>{item.pageUrl ?? '—'}</td>
                    <td>{item.appVersion ?? '—'}</td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Add a page-level gate test, matching the established pattern**

```typescript
// apps/web/app/admin/feedback/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadFeedbackListMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadFeedbackListMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./feedback-data', () => ({ loadFeedbackList: loadFeedbackListMock }));

import AdminFeedbackPage from './page';

describe('AdminFeedbackPage', () => {
  it('calls notFound (its own gate) when there is no admin user, before fetching feedback', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminFeedbackPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(loadFeedbackListMock).not.toHaveBeenCalled();
  });

  it('loads feedback for an admin, defaulting to the "all" filter', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminFeedbackPage({ searchParams: Promise.resolve({}) });
    expect(loadFeedbackListMock).toHaveBeenCalledWith({}, 'all');
  });
});
```

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `pnpm --filter @stack/web test feedback && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint`
Expected: all pass. Watch for the unused-import lint pattern seen repeatedly in this project.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/feedback/feedback-data.ts apps/web/app/admin/feedback/feedback-data.test.ts apps/web/app/admin/feedback/page.tsx apps/web/app/admin/feedback/page.test.tsx
git commit -m "feat(web): add admin Feedback list page"
```

---

### Task 2: Feedback detail loader + page (security tests E, F)

**Files:**
- Create: `apps/web/app/admin/feedback/[id]/feedback-detail-data.ts`
- Create: `apps/web/app/admin/feedback/[id]/page.tsx`
- Test: `apps/web/app/admin/feedback/[id]/feedback-detail-data.test.ts`
- Test: `apps/web/app/admin/feedback/[id]/page.test.tsx` (this is where security tests E and F live, naturally — the page's own gate IS the "non-admin can't read feedback" / "admin can read feedback" boundary)

**Interfaces:**
- Produces: `export type FeedbackDetail = { id: string; type: string; message: string; goal: string | null; email: string | null; pageUrl: string | null; userId: string | null; appVersion: string | null; createdAt: string; status: string; adminNote: string | null; resolvedAt: string | null }` and `export async function loadFeedbackDetail(db: SupabaseClient, id: string): Promise<FeedbackDetail | null>` (null when the id doesn't exist — the page should `notFound()` on null, same pattern as a missing admin resource anywhere else).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/feedback/[id]/feedback-detail-data.test.ts
import { describe, expect, it } from 'vitest';

import { loadFeedbackDetail } from './feedback-detail-data';

function fakeDb(row: unknown | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  } as never;
}

describe('loadFeedbackDetail', () => {
  it('returns the full record when the id exists', async () => {
    const db = fakeDb({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: 'Push my environment.',
      email: 'ada@example.com',
      page_url: '/beta',
      user_id: 'user-1',
      app_version: 'web',
      created_at: '2026-10-19T10:00:00Z',
      status: 'new',
      admin_note: null,
      resolved_at: null,
    });

    const result = await loadFeedbackDetail(db, 'f1');

    expect(result).toEqual({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: 'Push my environment.',
      email: 'ada@example.com',
      pageUrl: '/beta',
      userId: 'user-1',
      appVersion: 'web',
      createdAt: '2026-10-19T10:00:00Z',
      status: 'new',
      adminNote: null,
      resolvedAt: null,
    });
  });

  it('returns null when the id does not exist', async () => {
    const db = fakeDb(null);
    const result = await loadFeedbackDetail(db, 'does-not-exist');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test feedback-detail-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/feedback/[id]/feedback-detail-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackDetail = {
  id: string;
  type: string;
  message: string;
  goal: string | null;
  email: string | null;
  pageUrl: string | null;
  userId: string | null;
  appVersion: string | null;
  createdAt: string;
  status: string;
  adminNote: string | null;
  resolvedAt: string | null;
};

type FeedbackDetailRow = {
  id: string;
  type: string;
  message: string;
  goal: string | null;
  email: string | null;
  page_url: string | null;
  user_id: string | null;
  app_version: string | null;
  created_at: string;
  status: string;
  admin_note: string | null;
  resolved_at: string | null;
};

export const loadFeedbackDetail = async (
  db: SupabaseClient,
  id: string,
): Promise<FeedbackDetail | null> => {
  const { data, error } = await db
    .from('feedback')
    .select(
      'id, type, message, goal, email, page_url, user_id, app_version, created_at, status, admin_note, resolved_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as FeedbackDetailRow;
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    goal: row.goal,
    email: row.email,
    pageUrl: row.page_url,
    userId: row.user_id,
    appVersion: row.app_version,
    createdAt: row.created_at,
    status: row.status,
    adminNote: row.admin_note,
    resolvedAt: row.resolved_at,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test feedback-detail-data.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the detail page**

The status/note form is a client component (Task 3 wires its submit handler to the PATCH route built in that task) — for THIS task, render the form markup pointing at a route that doesn't exist yet is fine since Task 3 lands immediately after; do not stub a fake endpoint.

```typescript
// apps/web/app/admin/feedback/[id]/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import { AdminSidebar } from '../../_components/admin-sidebar';
import { FeedbackStatusForm } from './feedback-status-form';
import { loadFeedbackDetail } from './feedback-detail-data';

export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const { id } = await params;
  const detail = await loadFeedbackDetail(serviceClient(), id);
  if (!detail) notFound();

  return (
    <>
      <AdminSidebar active="feedback" />
      <main className="stak-admin-main">
        <h1>Feedback detail</h1>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Type</dt>
            <dd>{detail.type}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{detail.status}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{detail.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Source page</dt>
            <dd>{detail.pageUrl ?? '—'}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{detail.appVersion ?? '—'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(detail.createdAt).toLocaleString()}</dd>
          </div>
        </dl>
        <h2>Message</h2>
        <p>{detail.message}</p>
        {detail.goal ? (
          <>
            <h2>What they were trying to do</h2>
            <p>{detail.goal}</p>
          </>
        ) : null}
        <FeedbackStatusForm
          feedbackId={detail.id}
          initialStatus={detail.status}
          initialAdminNote={detail.adminNote ?? ''}
        />
      </main>
    </>
  );
}
```

- [ ] **Step 6: Add the page-level gate test (this IS security tests E and F — label them explicitly in the test names)**

```typescript
// apps/web/app/admin/feedback/[id]/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadFeedbackDetailMock } = vi.hoisted(() => ({
  getAdminUserMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadFeedbackDetailMock: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./feedback-detail-data', () => ({ loadFeedbackDetail: loadFeedbackDetailMock }));
vi.mock('./feedback-status-form', () => ({ FeedbackStatusForm: () => null }));

import AdminFeedbackDetailPage from './page';

describe('AdminFeedbackDetailPage', () => {
  it('E: non-admin user cannot read feedback -- notFound is called, loader never runs', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'f1' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadFeedbackDetailMock).not.toHaveBeenCalled();
  });

  it('F: admin user can read feedback -- renders the detail', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    loadFeedbackDetailMock.mockResolvedValue({
      id: 'f1',
      type: 'bug',
      message: 'It crashed.',
      goal: null,
      email: null,
      pageUrl: null,
      userId: null,
      appVersion: null,
      createdAt: '2026-10-19T10:00:00Z',
      status: 'new',
      adminNote: null,
      resolvedAt: null,
    });
    const result = await AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'f1' }) });
    expect(loadFeedbackDetailMock).toHaveBeenCalledWith({}, 'f1');
    expect(result).toBeTruthy();
  });

  it('calls notFound when the feedback id does not exist, even for an admin', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    loadFeedbackDetailMock.mockResolvedValue(null);
    await expect(
      AdminFeedbackDetailPage({ params: Promise.resolve({ id: 'missing' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
```

- [ ] **Step 7: Run tests (this task's new page component imports `FeedbackStatusForm`, which doesn't exist until Task 3 — create a temporary placeholder so this task's tests can run)**

Create a minimal placeholder so Task 2's own build/tests don't block on Task 3:

```typescript
// apps/web/app/admin/feedback/[id]/feedback-status-form.tsx
'use client';

/** Placeholder -- Task 3 replaces this with the real status/note form wired to PATCH /api/admin/feedback/[id]. */
export function FeedbackStatusForm({
  feedbackId,
}: {
  feedbackId: string;
  initialStatus: string;
  initialAdminNote: string;
}) {
  return <p>Status/note editing lands in the next task. (feedback id: {feedbackId})</p>;
}
```

Run: `pnpm --filter @stack/web test feedback && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/feedback/\[id\]/feedback-detail-data.ts apps/web/app/admin/feedback/\[id\]/feedback-detail-data.test.ts apps/web/app/admin/feedback/\[id\]/page.tsx apps/web/app/admin/feedback/\[id\]/page.test.tsx apps/web/app/admin/feedback/\[id\]/feedback-status-form.tsx
git commit -m "feat(web): add admin Feedback detail page (security tests E, F)"
```

---

### Task 3: Status/note update route handler + real form (security tests G, H)

**Files:**
- Create: `apps/web/app/api/admin/feedback/[id]/route.ts`
- Create: `apps/web/app/api/admin/feedback/[id]/route.test.ts` (this is where security tests G and H live)
- Modify: `apps/web/app/admin/feedback/[id]/feedback-status-form.tsx` (replace the Task 2 placeholder with the real form)

**Interfaces:**
- Consumes: `getAdminUser()`, `serviceClient()`.
- Produces: `PATCH` handler accepting `{ status?: 'new'|'reviewing'|'resolved'|'archived'; adminNote?: string }`, returning `{ ok: true }` on success or an error body with the matching status code.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/app/api/admin/feedback/[id]/route.test.ts
import { describe, expect, it, vi } from 'vitest';

const getAdminUserMock = vi.fn();
vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));

const updateMock = vi.fn().mockResolvedValue({ error: null });
const eqMock = vi.fn(() => ({ error: null }));
vi.mock('@/lib/supabase', () => ({
  serviceClient: () => ({
    from: () => ({
      update: (fields: unknown) => {
        updateMock(fields);
        return { eq: eqMock };
      },
    }),
  }),
}));

import { PATCH } from './route';

const req = (body: unknown) =>
  new Request('https://www.memstk.com/api/admin/feedback/f1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const ctx = { params: Promise.resolve({ id: 'f1' }) };

describe('PATCH /api/admin/feedback/[id]', () => {
  it('G: non-admin user cannot modify feedback status/note -- 404, no update attempted', async () => {
    getAdminUserMock.mockResolvedValue(null);
    const res = await PATCH(req({ status: 'resolved' }), ctx);
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('H: admin user can modify feedback status and note', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({ status: 'resolved', adminNote: 'Fixed in v2.' }), ctx);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        admin_note: 'Fixed in v2.',
        resolved_at: expect.any(String),
        resolved_by: 'admin-1',
      }),
    );
  });

  it('rejects an invalid status value without touching the database', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    const res = await PATCH(req({ status: 'not-a-real-status' }), ctx);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not set resolved_at/resolved_by for a non-resolved status change', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    updateMock.mockClear();
    await PATCH(req({ status: 'reviewing' }), ctx);
    const fields = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('resolved_at');
    expect(fields).not.toHaveProperty('resolved_by');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test "api/admin/feedback"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Write the route handler**

```typescript
// apps/web/app/api/admin/feedback/[id]/route.ts
import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

const VALID_STATUSES = ['new', 'reviewing', 'resolved', 'archived'] as const;
type Status = (typeof VALID_STATUSES)[number];
const isValidStatus = (value: unknown): value is Status =>
  typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) return Response.json({ ok: false, error: 'not-found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const { status, adminNote } = (body ?? {}) as { status?: unknown; adminNote?: unknown };

  if (status !== undefined && !isValidStatus(status)) {
    return Response.json({ ok: false, error: 'invalid-status' }, { status: 400 });
  }
  if (adminNote !== undefined && typeof adminNote !== 'string') {
    return Response.json({ ok: false, error: 'invalid-admin-note' }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  if (status !== undefined) {
    fields.status = status;
    if (status === 'resolved') {
      fields.resolved_at = new Date().toISOString();
      fields.resolved_by = admin.id;
    }
  }
  if (adminNote !== undefined) fields.admin_note = adminNote;

  const { id } = await params;
  const { error } = await serviceClient().from('feedback').update(fields).eq('id', id);

  if (error) {
    console.error('[api/admin/feedback] update failed:', error.code, error.message);
    return Response.json({ ok: false, error: 'storage-failed' }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test "api/admin/feedback"`
Expected: PASS (4 tests)

- [ ] **Step 5: Replace the Task 2 placeholder form with the real client component**

```typescript
// apps/web/app/admin/feedback/[id]/feedback-status-form.tsx
'use client';

import { useState } from 'react';

const STATUSES = ['new', 'reviewing', 'resolved', 'archived'] as const;

export function FeedbackStatusForm({
  feedbackId,
  initialStatus,
  initialAdminNote,
}: {
  feedbackId: string;
  initialStatus: string;
  initialAdminNote: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [adminNote, setAdminNote] = useState(initialAdminNote);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/feedback/${feedbackId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, adminNote }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Admin workflow</h2>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Admin note
        <textarea value={adminNote} onChange={(e) => setAdminNote(e.target.value)} />
      </label>
      <button onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {saved ? <p>Saved.</p> : null}
    </div>
  );
}
```

- [ ] **Step 6: Run full suite, typecheck, lint, and build (last task of Phase 4)**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint && pnpm --filter @stack/web build`
Expected: all pass; build lists `/admin/feedback`, `/admin/feedback/[id]`, and `/api/admin/feedback/[id]` as dynamic (ƒ).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/admin/feedback/\[id\]/route.ts apps/web/app/api/admin/feedback/\[id\]/route.test.ts apps/web/app/admin/feedback/\[id\]/feedback-status-form.tsx
git commit -m "feat(web): add admin feedback status/note update endpoint (security tests G, H)"
```

---

## Phase 4 Completion Checklist

- [ ] All 3 tasks committed individually.
- [ ] Security tests E, F, G, H all present and passing (E/F in `feedback/[id]/page.test.tsx`, G/H in `api/admin/feedback/[id]/route.test.ts`).
- [ ] Admin notes are never rendered on any public page or returned by any public API.
- [ ] Full web suite, typecheck, lint, build all pass.
- [ ] Phase 5 plan (System page + visual QA + final security review) to be written next.

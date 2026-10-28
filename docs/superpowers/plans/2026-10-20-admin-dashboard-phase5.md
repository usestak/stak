# STAK Admin v1 — Phase 5: System Page + Metric Definitions + Final Review

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the System page (the last planned admin section), write the permanent metric-definitions doc, then do the full-project final pass: a whole-branch security/consistency review across all 5 phases, and a scoped visual/responsive check.

**Architecture:** System follows the exact `-data.ts` + independently-gated page pattern used by every other admin page. Metric definitions become a committed doc (not just spec prose) so a future developer doesn't have to reconstruct what each number means from the loader code.

**Tech Stack:** Next.js 15 App Router, `@supabase/supabase-js`, Vitest.

## Global Constraints

- The System page must never expose secrets or environment variable values — only derived, safe facts (version strings, a boolean connectivity result, aggregate counts).
- This page must independently call `getAdminUser()`/`notFound()` before any data fetch, same as every other admin page.
- Never use `git add .` / `git add -A` — stage exact file paths.
- No new migration needed.
- **Visual QA scope note**: the plan's original design spec calls for manual inspection at 1440/1024/768/390 in a live browser. Given this session's environment constraints (a background dev-server process was already killed once this session for low system memory), Task 3 does a code-level responsive review instead (reading the actual CSS rules and page markup against the breakpoints) rather than launching a live browser session. This is explicitly a narrower check than live visual QA — flag it as such in the final report rather than claiming full manual QA was performed.

---

### Task 1: System page

**Files:**

- Create: `apps/web/app/admin/system/system-data.ts`
- Create: `apps/web/app/admin/system/page.tsx`
- Test: `apps/web/app/admin/system/system-data.test.ts`
- Test: `apps/web/app/admin/system/page.test.tsx`

**Interfaces:**

- Produces: `export type SystemStatus = { webVersion: string; cliVersion: string; dbConnected: boolean; recentFailureCount: number }` and `export async function loadSystemStatus(db: SupabaseClient, webVersion: string, cliVersion: string): Promise<SystemStatus>`.

- [ ] **Step 1: Write the failing test**

```typescript
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
              : resolve({
                  data: null,
                  error: { message: 'connection refused' },
                }),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test "admin/system"`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/system/system-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type SystemStatus = {
  webVersion: string;
  cliVersion: string;
  dbConnected: boolean;
  recentFailureCount: number;
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const loadSystemStatus = async (
  db: SupabaseClient,
  webVersion: string,
  cliVersion: string,
): Promise<SystemStatus> => {
  // Connectivity check: a trivial, cheap read. A connectivity FAILURE is a
  // real (if degraded) answer for this page to show -- it must not throw
  // and take the whole page down with it, unlike every other admin loader
  // in this project (which deliberately throws on error). This is the one
  // intentional exception, because "is the DB reachable" is itself the
  // thing being measured.
  const { error: connectError } = await db
    .from('profiles')
    .select('user_id')
    .limit(1);
  const dbConnected = !connectError;

  let recentFailureCount = 0;
  if (dbConnected) {
    const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    const { count, error } = await db
      .from('product_events')
      .select('id', { count: 'exact', head: true })
      .eq('success', false)
      .gte('created_at', since);
    if (!error) recentFailureCount = count ?? 0;
  }

  return { webVersion, cliVersion, dbConnected, recentFailureCount };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test "admin/system"`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the page**

The web version comes from `apps/web/package.json`'s `version` field; the published CLI version comes from `packages/cli/package.json`'s `version` field. Import these as JSON (Next.js supports `import pkg from '../../../package.json'` style imports for this purpose) rather than reading the filesystem at request time.

```typescript
// apps/web/app/admin/system/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

import webPackageJson from '../../../package.json';
import cliPackageJson from '../../../../../packages/cli/package.json';
import { AdminSidebar } from '../_components/admin-sidebar';
import { loadSystemStatus } from './system-data';

export default async function AdminSystemPage() {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const status = await loadSystemStatus(
    serviceClient(),
    webPackageJson.version,
    cliPackageJson.version,
  );

  return (
    <>
      <AdminSidebar active="system" />
      <main className="stak-admin-main">
        <h1>System</h1>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Web app version</dt>
            <dd>{status.webVersion}</dd>
          </div>
          <div>
            <dt>Published CLI version</dt>
            <dd>{status.cliVersion}</dd>
          </div>
          <div>
            <dt>Database connectivity</dt>
            <dd>{status.dbConnected ? 'Connected' : 'Disconnected'}</dd>
          </div>
          <div>
            <dt>Failures (last 24h)</dt>
            <dd>{status.recentFailureCount}</dd>
          </div>
          <div>
            <dt>CLI version breakdown</dt>
            <dd>Unavailable — no CLI version header exists yet</dd>
          </div>
        </dl>
      </main>
    </>
  );
}
```

Note: verify the relative import path to `packages/cli/package.json` actually resolves given this repo's real directory depth (`apps/web/app/admin/system/page.tsx` → repo root is 5 levels up: `../../../../../`) — count it against the real path on disk before trusting the snippet above, and adjust if the implementer's own count differs from this plan's.

- [ ] **Step 6: Add a page-level gate test**

```typescript
// apps/web/app/admin/system/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadSystemStatusMock } = vi.hoisted(
  () => ({
    getAdminUserMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    loadSystemStatusMock: vi.fn().mockResolvedValue({
      webVersion: '0.1.0',
      cliVersion: '0.2.0-beta.1',
      dbConnected: true,
      recentFailureCount: 0,
    }),
  }),
);

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./system-data', () => ({ loadSystemStatus: loadSystemStatusMock }));

import AdminSystemPage from './page';

describe('AdminSystemPage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(AdminSystemPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadSystemStatusMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    const result = await AdminSystemPage();
    expect(loadSystemStatusMock).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run full suite, typecheck, lint, build**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint && pnpm --filter @stack/web build`
Expected: all pass; `/admin/system` listed as dynamic (ƒ).

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/system/system-data.ts apps/web/app/admin/system/system-data.test.ts apps/web/app/admin/system/page.tsx apps/web/app/admin/system/page.test.tsx
git commit -m "feat(web): add admin System page"
```

---

### Task 2: Metric definitions doc

**Files:**

- Create: `docs/admin-metric-definitions.md`

**Interfaces:**

- None (documentation task).

- [ ] **Step 1: Write the doc**

Pull the exact definitions already established and implemented across Phases 2–4 (do not invent new ones — transcribe what the code actually computes):

```markdown
# STAK Admin — Metric Definitions

Permanent reference so these numbers don't drift as the dashboard evolves.
If a definition changes, update this file in the same commit.

## Activated user

A user with at least one row in `environment_versions` (i.e. has made a
successful authenticated Cloud push), ever — not scoped to the selected
date range. Computed in `apps/web/app/admin/overview-data.ts`.

## Activation rate

Activated users ÷ total signed-up users, both all-time counts (not
range-scoped — see "Activated user"). Returns `null`, not `NaN`, when
there are zero signed-up users.

## Portable user

A user with active (non-revoked) machines spanning >= 2 distinct
`machine_id`s. Computed once, shared across Overview/Activation/Usage via
`apps/web/lib/admin-metrics.ts`'s `loadActiveMachinesByUser`/
`countPortableUsers` — every page that shows this number goes through the
same implementation so the figure can't drift between pages.

## Push / pull success rate

Successful `product_events` of that type ÷ (successful + failed) of that
type, in the selected date range. Returns `null` when there are zero
attempts of that type in range. Computed via server-side `head:true`
counts in `apps/web/app/admin/reliability/reliability-data.ts`.

**Caveat**: `cloud.pull.succeeded`/`cloud.pull.failed` events are emitted
by the same server-side `getEnvironment` call used by `stak push` and
`stak status` as an internal precondition check, not only by `stak pull`.
The server has no signal to distinguish these without a CLI change, so
this is really an "environment read" rate, not a pure pull rate — Usage's
page copy reflects this; Reliability's doesn't yet (follow-up candidate).
`cloud.pull.failed` specifically excludes the benign
`remote-environment-not-found` case (a first-time user's push/status
against a never-created environment), so it isn't inflated by that.

## Open feedback

`feedback.status` in `('new', 'reviewing')`.

## Weekly active user (WAU)

**Not implemented as of Phase 5.** Deferred — see Phase 1 final-review
carry-over notes; no page currently renders a WAU figure.

## CLI version breakdown

**Unavailable.** The CLI sends no version header on any Cloud API
request. Not faked — every page that would show this explicitly renders
"Unavailable — no CLI version header exists yet" rather than a number.

## Row-cap caveat (applies to several loaders)

Hosted Supabase/PostgREST caps any single response at 1000 rows by
default. Several admin loaders (Usage's per-day buckets, Reliability's
failure grouping, the Feedback and Users lists) fetch row-level data for
aggregation that can't be expressed as a single database count, and will
silently truncate once the underlying table/range exceeds that cap, with
no on-page indication. Accepted as a known limitation pending a proper
server-side aggregate (RPC/view) — see the Phase 2/3/4 ledger entries in
`.superpowers/sdd/progress.md` for the specific instances and reasoning.
```

- [ ] **Step 2: Commit**

```bash
git add docs/admin-metric-definitions.md
git commit -m "docs: add permanent admin metric definitions reference"
```

---

### Task 3: Scoped responsive/visual review + full-project final security pass

This task is primarily a review/audit task, not new feature code — it may surface small fixes, which should be made directly rather than spun into new sub-tasks.

- [ ] **Step 1: Responsive/visual code review (not a live browser session — see Global Constraints note)**

Read `apps/web/app/admin/admin.css` in full alongside every admin page's JSX, and check against these breakpoints by reasoning about the actual CSS rules (not by rendering):

- 1440/1024 (desktop, primary): sidebar (216px) + main content area — confirm no fixed-width element in any page would overflow at 1024px.
- 768: confirm the existing `@media (max-width: 768px)` rule (sidebar becomes full-width, stacks above content) actually applies to every page using `.stak-admin`/`.stak-admin-sidebar` (all of them should, since it's the shared layout).
- 390 (narrow phone): confirm every table on every admin page (Users, Reliability's recent failures, Feedback list) is wrapped in `.stak-admin-table-wrap` (horizontal scroll), not a bare `<table>` that would force page-level horizontal overflow. Grep for `<table>` across `apps/web/app/admin/**/*.tsx` and verify each one's parent is `.stak-admin-table-wrap`.

Fix directly any bare `<table>` found without the wrapper.

- [ ] **Step 2: Full-project empty/loading/error state check**

Grep every admin page for its empty-state copy (e.g. "No feedback yet.", "No failures in this period.") and confirm every list-rendering page has one (not a blank list with no message). Confirm `apps/web/app/admin/error.tsx` (added in Phase 2) is still the active error boundary for every admin route (it's scoped by file location to all of `app/admin/**`, so this should already be true — verify, don't assume).

- [ ] **Step 3: Final security re-confirmation across all 5 phases**

This is a condensed re-check, not a re-derivation of every prior review:

- Grep all of `apps/web/app/admin/**/page.tsx` and confirm every single one calls `getAdminUser()` as its own first statement (not relying solely on `layout.tsx`).
- Grep all of `apps/web/app/api/admin/**/route.ts` and confirm the same for every HTTP method exported.
- Confirm `apps/web/lib/admin.ts` and `apps/web/lib/supabase.ts` contain no `'use client'` directive (the original Phase 1 static check, re-run once more at the end).
- Confirm no admin page or route logs or renders a Supabase service-role key, environment variable value, or raw stack trace to the client.

- [ ] **Step 4: Run full verification**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint && pnpm --filter @stack/web build && pnpm --filter @stack/cloud-server test`

- [ ] **Step 5: Commit any fixes made during this task's review (if none were needed, skip committing — don't create an empty commit)**

---

## Phase 5 Completion Checklist

- [ ] System page live, independently gated, no secrets exposed.
- [ ] `docs/admin-metric-definitions.md` committed.
- [ ] Responsive/empty-state/security re-check complete, with explicit note that visual QA was code-level, not a live browser session, if that scope reduction was used.
- [ ] Full verification (web suite, typecheck, lint, build, cloud-server suite) passes.
- [ ] This closes all 5 phases of STAK Admin v1. Final step: invoke superpowers:finishing-a-development-branch to decide how `feat/admin-dashboard` gets merged/PR'd, and hand back the production migration-apply procedure (owner bootstrap doc already exists at `docs/admin-bootstrap.md`; migrations through `0017` now need applying).

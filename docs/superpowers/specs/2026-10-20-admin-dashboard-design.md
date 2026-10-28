# STAK Admin v1 — Design

Status: approved for implementation planning
Date: 2026-10-20

## Goal

A permanent internal product-operations admin surface at `/admin`, usable through
Public Beta, launch, and post-launch. Not a temporary debug tool. Not accessible
to ordinary users. Answers: are people signing up, reaching activation, dropping
out, returning; are push/pull/recovery reliable; what feedback is coming in; which
areas are used; are there emerging reliability problems.

## Architecture audit (findings)

- App: `apps/web` (Next.js 15.5.25, App Router, no middleware — auth gating is
  per-page via `getSessionUser()` + `redirect()`).
- Supabase helpers: `apps/web/lib/supabase-server.ts` (anon key, cookie session,
  for Server Components/Route Handlers), `apps/web/lib/supabase-browser.ts`
  (client-side, Realtime only), `apps/web/lib/supabase.ts` → `serviceClient()`
  (service-role, server-only, already the established pattern for privileged
  server-side reads/writes). Session resolution: `apps/web/lib/session.ts` →
  `getSessionUser()`.
- **No admin/role concept exists anywhere** — no `is_admin`, no roles table, no
  app-level claims. Current model is binary: service-role (full access,
  server-only) or RLS owner-only (`auth.uid() = user_id`).
- Schema (migrations `0001`–`0012` in `supabase/migrations/`): `profiles`,
  `cli_auth_sessions`, `cli_tokens` (has `machine_id`), `environments` /
  `environment_versions` (append-only, push history), `snapshots`, `machines`
  (multi-machine-per-user already modeled, has `revoked_at`),
  `machine_skill_versions`, `machine_project_presence`, `public_handles`,
  `public_stacks`, `public_stack_versions`, `memory_profiles`,
  `memory_backups`, `memory_recovery_methods`, `memory_recovery_sessions`,
  `cloud_projects`, `skill_review_checks`, `user_stacks`,
  `user_stack_versions`, `feedback` (migration `0012`, RLS enabled with zero
  policies — service-role only).
- Push/pull: single catch-all route `apps/web/app/api/v1/[[...path]]/route.ts`
  → `handleCloudRequest()` in `packages/cloud-server/src/handler.ts`. Push =
  `commitEnvironmentVersion`; pull = `getEnvironment`.
- **No event/analytics/audit-log infrastructure exists.** No success/failure
  logging beyond the version rows themselves (which only record successful
  commits). Pull leaves no trace at all. This is a genuine gap, not something
  derivable from existing data — confirmed with the user, in scope to fix.
- Migrations: `supabase/migrations/NNNN_description.sql`, applied manually
  (SQL editor or `supabase db push`) — no automated CI apply step.
- Visual system: no Tailwind/shadcn — hand-rolled scoped CSS per route. The
  signed-in app uses a dark "instrument panel" theme (`.stak` scope in
  `apps/web/app/overview/shell.css`: `--bg`, `--panel`, `--ink`, `--chip`,
  status colors `--orange`/`--green`/`--amber`/`--red`, IBM Plex fonts) plus
  `AppSidebar` (`apps/web/app/_components/app-sidebar.tsx`). Table/pill
  precedent: `apps/web/app/projects/_components/projects-table.tsx`,
  `apps/web/app/skills/_components/skills-table.tsx`.
- CLI sends no version header today (`packages/cloud-client/src/client.ts`
  only sets `accept`/`authorization`/`content-type`). CLI-version breakdown
  is explicitly out of scope for v1 (no new CLI release to support it).

## Existing-data metrics vs newly instrumented

Derivable from existing tables, no new instrumentation:

- Total/new users, activation (first push), activation rate, median time to
  first push — `profiles`, `environment_versions`.
- CLI-authenticated users — `cli_tokens`.
- Portable users (multi-machine) — `machines` (distinct `machine_id` per
  `user_id` where `revoked_at is null`).
- Feedback counts/filters — `feedback`.

Require new `product_events` table + instrumentation (confirmed in scope):

- Pull success/failure (pull has zero trace today).
- Push failure (only successful commits are currently recorded).
- Memory recovery success/conflict.
- Public STAK try/use and try→use conversion.
- Weekly-active-users definition that includes pull activity.

Explicitly deferred/unavailable in v1 (not faked):

- CLI version breakdown in Reliability/System — no header exists; do not add
  a new CLI release just to support this.
- Agent usage — not observable server-side without local CLI telemetry; stays
  unavailable.
- `/admin/public-staks` as its own page — folded into Usage for v1 (not
  enough distinct metrics yet to justify its own IA slot).

## Admin authorization model

New table `public.admin_users`:

```sql
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin')),
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
-- no policies — service-role client only, same posture as public.feedback
```

New helper `apps/web/lib/admin.ts`:

```ts
export async function getAdminUser() {
  const user = await getSessionUser(); // existing helper
  if (!user) return null;
  const db = serviceClient(); // existing service-role helper
  const { data } = await db
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data) return null;
  return { ...user, role: data.role as 'owner' | 'admin' };
}
```

Rules:

- Every `/admin/*` page is a Server Component; first line calls
  `getAdminUser()` and calls `notFound()` if null (404, not redirect — don't
  reveal the route exists).
- Every admin mutation Route Handler (feedback status/note updates) repeats
  the same server-side check before touching data. No middleware (consistent
  with existing no-middleware convention) — the check lives at each boundary.
- The service-role key and the admin check never run client-side; admin pages
  fetch data via Server Components / Route Handlers only, never directly from
  the browser Supabase client.
- `AppSidebar`/nav only renders the Admin entry when `getAdminUser()` (called
  server-side where the shell renders) returns non-null. Hiding the link is a
  UX nicety, never the actual gate.
- Every `/admin/*` page sets `export const dynamic = 'force-dynamic'` and a
  `noindex` meta — no caching, no indexing.

## Schema migrations

- `0013_admin_users.sql` — table above.
- `0014_feedback_workflow.sql`:
  ```sql
  alter table public.feedback
    add column status text not null default 'new'
      check (status in ('new','reviewing','resolved','archived')),
    add column admin_note text,
    add column resolved_at timestamptz,
    add column resolved_by uuid references auth.users(id);
  create index feedback_status_idx on public.feedback (status);
  ```
- `0015_product_events.sql`:
  ```sql
  create table public.product_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete set null,
    event_name text not null,
    machine_id text,
    success boolean,
    error_code text,
    cli_version text,
    metadata jsonb,
    created_at timestamptz not null default now()
  );
  alter table public.product_events enable row level security;
  -- no policies — service-role (recordEvent helper + admin reads) only
  create index product_events_name_created_idx on public.product_events (event_name, created_at desc);
  create index product_events_user_created_idx on public.product_events (user_id, created_at desc);
  ```

Event names (stable, product-oriented): `cloud.push.succeeded`,
`cloud.push.failed`, `cloud.pull.succeeded`, `cloud.pull.failed`,
`memory.recovered`, `memory.restore_conflict`, `public_stak.tried`,
`public_stak.used`. `metadata` is allowlisted per event (e.g.
`environment_id`, `version_id` only) — never file contents, paths,
credentials, or raw exception text.

Production apply: these are new migration files added to
`supabase/migrations/`, following the existing manual-apply convention
(SQL editor or `supabase db push`) — no production schema mutation happens
automatically during implementation; exact apply steps are handed back at
the end.

## Event instrumentation (best-effort, non-blocking)

New `packages/cloud-server/src/events.ts`:

```ts
export async function recordEvent(e: {
  userId: string | null;
  eventName: string;
  machineId?: string;
  success?: boolean;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await serviceClient().from('product_events').insert({/* ... */});
  } catch (err) {
    console.error('[product_events] write failed', err); // never throws
  }
}
```

Called from `handler.ts` around `commitEnvironmentVersion` (push, both
success and catch paths) and `getEnvironment` (pull, both paths), and from
the memory-recovery and public-stack-read service calls. This is the only
touch point on live request-handling code; a failure here must never change
the response returned to the caller.

## Admin bootstrap (owner)

No identity is hardcoded. After migrations are applied, the one-time
production procedure (handed back, not run automatically):

1. Supabase Dashboard → Authentication → Users → find account by email →
   copy the user UUID.
2. SQL Editor:
   ```sql
   insert into public.admin_users (user_id, role) values ('<uuid>', 'owner');
   ```

## Information architecture

Sidebar: Overview · Users · Activation · Usage · Reliability · Feedback ·
System. (Public STAKs folded into Usage per above; Billing/Teams/Growth/
Support can be added later without restructuring.)

- **`/admin`** — date-range pills (24h/7d/30d/all time). Total/new users,
  activated users + rate, WAU, push/pull success rate, portable users,
  new/open feedback.
- **`/admin/users`** — list (identity, joined, last activity, activation
  state, first push date, machine count, push/pull counts, Memory usage
  indicator, feedback count), search, click → detail drawer. Never shows
  Memory/Skill contents, credentials, env vars, filesystem paths, terminal
  history, private repo contents.
- **`/admin/activation`** — funnel Accounts → CLI-authenticated → First push
  → First pull → Portable, conversion %, median time-between (SQL
  `percentile_cont`), tooltips defining every stage.
- **`/admin/usage`** — pushes/pulls per day, active machines, Memory
  backup/recovery counts, public STAK publish/try/use/conversion.
- **`/admin/reliability`** — push/pull/memory success rates, recent-failures
  table (operation, error_code, count, affected users, first/last seen).
  CLI-version dimension explicitly marked unavailable.
- **`/admin/feedback`** — newest-first list/filters (All/New/Bugs/
  Confusing/Ideas/Resolved), detail view, status/note/resolve/archive
  workflow on `public.feedback` + new columns. Admin notes never exposed
  publicly.
- **`/admin/system`** — web app version, published CLI version, DB
  connectivity check, recent `product_events` failure summary. No secrets/
  env values ever shown.

Every page/section has explicit loading, empty (e.g. "No feedback yet.",
"No failures in this period."), and error states — no blank cards, no raw
exception text.

## Visual approach

Extend the existing dark `.stak` instrument-panel theme and `AppSidebar`
pattern rather than introducing Tailwind/shadcn. New
`apps/web/app/admin/admin.css` scoped the same way. Tables/pills/filter
toolbars follow the existing hand-rolled pattern in `projects-table.tsx` /
`skills-table.tsx`. Desktop-primary (1440/1024 primary targets), usable down
to 768/390 (tables become cards or scroll intentionally; no accidental
page-level horizontal overflow).

## Security tests (release-critical)

New test file(s) exercising the admin helper + representative route
handlers directly (session/admin-table state mocked, not full e2e):
A) anonymous → no `/admin` access, B) authenticated non-admin → no access,
C) admin → access, D) non-admin → admin data endpoints/actions rejected,
E) non-admin → cannot read feedback, F) admin → can read feedback,
G) non-admin → cannot modify feedback status/note, H) admin → can,
I) admin/service-role logic never ships in the client bundle (static check
that `serviceClient()`/admin-check code isn't imported from any `'use
client'` module).

## Phasing

1. Admin auth model + schema migrations (`0013`–`0015`) + admin shell/IA +
   `getAdminUser()` + security tests A–D, I.
2. Overview + Users + Activation (existing-data metrics only).
3. Usage + Reliability + `product_events` instrumentation (push/pull/
   recovery/public-stak handlers).
4. Feedback inbox (workflow fields, status/note UI, tests E–H).
5. System + visual QA pass (1440/1024/768/390) + full security review +
   metric-definitions doc.

Continue through all phases unless a genuine schema/authorization
contradiction requires a stop.

## Metric definitions (to also land as in-repo docs so they don't drift)

- **Activated user**: a user with at least one successful authenticated
  Cloud push (`environment_versions` row exists for them).
- **Weekly active user**: a user with at least one push, pull, or other
  `product_events` success in the trailing 7 days.
- **Portable user**: a user with activity (push or pull) associated with
  ≥2 distinct non-revoked `machine_id`s.
- **Push/pull success rate**: successful `product_events` of that type ÷
  total attempts of that type in the selected period.
- **Activation rate**: activated users ÷ total signed-up users in period.
- **Open feedback**: `feedback.status in ('new','reviewing')`.

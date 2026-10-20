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

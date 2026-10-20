-- Public Beta website feedback. Mirrors the cli_auth_sessions/cli_tokens posture
-- (0001_stack_cloud.sql): RLS is enabled with NO policies at all, so anon/
-- authenticated PostgREST callers can neither insert nor select. The only write
-- path is the Next.js route handler using the service-role client after it has
-- validated the body against packages/spec's feedbackRequestSchema — RLS here is
-- defense-in-depth, not the enforcement point. Feedback is never exposed to any
-- public API or page; there is deliberately no select policy for any role.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('bug', 'confusing', 'idea', 'other')),
  message text not null check (char_length(message) between 1 and 4000),
  goal text check (goal is null or char_length(goal) <= 2000),
  email text check (email is null or char_length(email) <= 320),
  page_url text check (page_url is null or char_length(page_url) <= 2048),
  -- Set only when the submitter had an authenticated web session; null for
  -- anonymous submissions, which are allowed.
  user_id uuid references auth.users (id) on delete set null,
  user_agent text,
  app_version text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
-- No policies: insert/select only via the service-role client in server code.

create index if not exists feedback_created_at_idx on public.feedback (created_at desc);

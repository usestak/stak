-- Permanent admin workflow fields for public.feedback (0012_feedback.sql).
-- Additive only: no existing column/constraint changes. The default 'new'
-- status means every pre-existing feedback row is immediately "new" under
-- the admin workflow with no backfill needed.
alter table public.feedback
  add column if not exists status text not null default 'new'
    check (status in ('new', 'reviewing', 'resolved', 'archived')),
  add column if not exists admin_note text,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references auth.users (id);

create index if not exists feedback_status_idx on public.feedback (status);

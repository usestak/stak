-- Dedicated, queryable canonical Git identity so Cloud-side project sync can recognize
-- "this user already owns a logical Project for this exact Git repo" without
-- string-sniffing the presentation `name` column (a local basename is indistinguishable
-- from a git canonical by string shape alone, and identity must never be inferred from
-- presentation text).
--
-- Nullable: only Git-backed Projects populate it. Existing rows (including any
-- pre-existing duplicate rows from before this reconciliation existed) are left NULL and
-- are NOT retroactively backfilled here — they get populated naturally the next time
-- that Project syncs, and cleanup of pre-existing duplicates is a separate, explicit,
-- reviewed step (never automatic, never by this migration).
alter table public.cloud_projects
  add column if not exists git_canonical text;

-- Case-folded to match the CLI's own case-insensitive canonical comparison (two
-- checkouts whose remote URL differs only in owner/repo casing must still collide).
-- Partial: only enforced where a Project actually has a Git canonical, so NULL rows
-- (local-only Projects, and any historical duplicate rows left at NULL) never conflict
-- with each other or block this migration. Defense in depth underneath the application
-- reconciliation check in syncProjects: a duplicate insert is impossible once populated.
create unique index if not exists cloud_projects_owner_git_canonical_idx
  on public.cloud_projects (user_id, lower(git_canonical))
  where git_canonical is not null;

-- Supports admin dashboard date-range queries (Overview/Activation/Users).
-- Additive only: no existing column/constraint changes.
create index if not exists profiles_created_at_idx
  on public.profiles (created_at);

-- created_at leads: the only time-filtered query on this table
-- (overview-data.ts's date-range push count) filters on created_at alone,
-- so it needs to lead the composite for an index (range) scan.
create index if not exists environment_versions_created_user_idx
  on public.environment_versions (created_at, user_id);

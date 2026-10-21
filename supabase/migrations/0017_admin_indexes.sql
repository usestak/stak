-- Supports admin dashboard date-range queries (Overview/Activation/Users).
-- Additive only: no existing column/constraint changes.
create index if not exists profiles_created_at_idx
  on public.profiles (created_at);

-- Note: an environment_versions_created_user_idx index was considered here
-- for overview-data.ts's date-range push count, but that query was changed
-- (Phase 2 fix eb92640) to compute activatedUsers as an all-time figure,
-- not range-filtered -- no current admin query filters environment_versions
-- by created_at, so no index on it was added. If a future loader adds such
-- a filter, add the index then (leading with created_at, since that's the
-- column actually filtered on).

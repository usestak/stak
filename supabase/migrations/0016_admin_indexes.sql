-- Supports admin dashboard date-range queries (Overview/Activation/Users).
-- Additive only: no existing column/constraint changes.
create index if not exists profiles_created_at_idx
  on public.profiles (created_at);

create index if not exists environment_versions_user_created_idx
  on public.environment_versions (user_id, created_at);

create index if not exists cli_tokens_created_at_idx
  on public.cli_tokens (created_at);

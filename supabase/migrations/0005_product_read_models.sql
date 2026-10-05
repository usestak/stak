-- 0005_product_read_models.sql — Phase P3: product read models + account-side writes.
--
-- Backward compatible and additive: new nullable columns and one new child table. No
-- existing row or column changes meaning; pre-P3 machines/tokens simply have null in the
-- new columns, and an account has no cloud_projects rows until its next CLI project sync.
--
-- Privacy: cloud_projects stores the opaque Project ID, lifecycle, and an optional safe
-- display name ONLY. No filesystem path (absolute or home-relative), no machine-local
-- binding, and no Memory content is ever stored here. Writes happen through the service
-- role; RLS grants owners read-only access for the signed-in web product.

-- Machine revoke keeps the row as a revoked audit record (never deletes Skills/Projects/
-- Memory); the token gains its machine binding so a revoke can target it.
alter table public.machines
  add column if not exists revoked_at timestamptz;

alter table public.cli_tokens
  add column if not exists machine_id uuid;

create table if not exists public.cloud_projects (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  lifecycle text not null default 'active' check (lifecycle in ('active', 'archived')),
  name text,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

create index if not exists cloud_projects_owner_idx
  on public.cloud_projects (user_id);

alter table public.cloud_projects enable row level security;

-- Owner read-only; all writes go through the service role (account-side service logic).
create policy cloud_projects_owner_select on public.cloud_projects
  for select using (auth.uid() = user_id);

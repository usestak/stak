-- 0004_machine_checkin.sql — Phase P1: machine check-in read model.
--
-- Backward compatible: adds nullable columns to public.machines and two new child
-- tables. No existing row or column changes meaning; pre-P1 machines simply have null
-- check-in fields and no skill/presence rows until their next CLI check-in.
--
-- Privacy: machine_project_presence stores PRESENCE ONLY (a boolean per project). No
-- filesystem path (absolute or home-relative) is ever stored. No Memory content is ever
-- stored here. Writes happen through the service role; RLS grants owners read-only access
-- for the signed-in web product.

alter table public.machines
  add column if not exists name text,
  add column if not exists agents_detected text[] not null default '{}',
  add column if not exists last_checkin_at timestamptz,
  add column if not exists memory_backed_up boolean not null default false;

create table if not exists public.machine_skill_versions (
  user_id uuid not null references auth.users (id) on delete cascade,
  machine_id uuid not null,
  skill_id text not null,
  installed_version text not null,
  primary key (user_id, machine_id, skill_id)
);

create table if not exists public.machine_project_presence (
  user_id uuid not null references auth.users (id) on delete cascade,
  machine_id uuid not null,
  project_id text not null,
  present boolean not null,
  primary key (user_id, machine_id, project_id)
);

create index if not exists machine_skill_versions_owner_idx
  on public.machine_skill_versions (user_id, machine_id);
create index if not exists machine_project_presence_owner_idx
  on public.machine_project_presence (user_id, machine_id);

alter table public.machine_skill_versions enable row level security;
alter table public.machine_project_presence enable row level security;

create policy machine_skill_versions_owner_select on public.machine_skill_versions
  for select using (auth.uid() = user_id);
create policy machine_project_presence_owner_select on public.machine_project_presence
  for select using (auth.uid() = user_id);

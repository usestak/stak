-- Phase 8 Stack Cloud schema.
-- Server code authenticates the opaque CLI token and derives the user before
-- using the service role. RLS below is defense-in-depth for any browser-scoped
-- access; the service role bypasses it.

create extension if not exists "pgcrypto";

-- Profiles ------------------------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_username text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- CLI device-authorization sessions ----------------------------------------
create table if not exists public.cli_auth_sessions (
  session_id uuid primary key,
  user_code text not null,
  device_secret_hash text not null unique,
  status text not null check (status in ('pending','approved','consumed','expired','denied')),
  user_id uuid references auth.users (id) on delete cascade,
  machine_id uuid,
  label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists cli_auth_sessions_user_code_idx
  on public.cli_auth_sessions (user_code);

-- Opaque CLI bearer tokens (only the hash is stored) ------------------------
create table if not exists public.cli_tokens (
  token_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists cli_tokens_user_idx on public.cli_tokens (user_id);

-- Environments and immutable versions --------------------------------------
create table if not exists public.environments (
  environment_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  latest_version_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.environment_versions (
  version_id uuid primary key,
  environment_id uuid not null references public.environments (environment_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version_number integer not null,
  digest text not null,
  bundle jsonb not null,
  machine_id uuid,
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  unique (environment_id, version_number)
);
create unique index if not exists environment_versions_idempotency_idx
  on public.environment_versions (user_id, idempotency_key)
  where idempotency_key is not null;

alter table public.environments
  add constraint environments_latest_version_fk
  foreign key (latest_version_id)
  references public.environment_versions (version_id)
  deferrable initially deferred;

-- Per-user private snapshot metadata ---------------------------------------
create table if not exists public.snapshots (
  user_id uuid not null references auth.users (id) on delete cascade,
  content_hash text not null,
  archive_hash text not null,
  byte_size bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, content_hash)
);

-- Informational machine metadata (no home paths / device fingerprints) -----
create table if not exists public.machines (
  user_id uuid not null references auth.users (id) on delete cascade,
  machine_id uuid not null,
  platform text,
  arch text,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz,
  primary key (user_id, machine_id)
);

-- Append-only guard: environment_versions may never be updated in place ------
create or replace function public.forbid_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'environment_versions are immutable';
end;
$$;
drop trigger if exists environment_versions_immutable on public.environment_versions;
create trigger environment_versions_immutable
  before update on public.environment_versions
  for each row execute function public.forbid_version_update();

-- Atomic optimistic version commit -----------------------------------------
create or replace function public.commit_environment_version(
  p_user_id uuid,
  p_name text,
  p_bundle jsonb,
  p_digest text,
  p_expected_latest_version_id uuid,
  p_machine_id uuid,
  p_idempotency_key uuid,
  p_environment_id uuid,
  p_version_id uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_env public.environments;
  v_current_latest uuid;
  v_previous_number integer;
  v_version public.environment_versions;
  v_created_new boolean := false;
begin
  select * into v_env from public.environments
    where user_id = p_user_id and name = p_name for update;

  if not found then
    v_current_latest := null;
  else
    v_current_latest := v_env.latest_version_id;
  end if;

  if v_current_latest is distinct from p_expected_latest_version_id then
    raise exception 'STACK_REMOTE_CONFLICT';
  end if;

  if not found then
    insert into public.environments (environment_id, user_id, name, latest_version_id, created_at)
      values (p_environment_id, p_user_id, p_name, null, p_now)
      returning * into v_env;
    v_created_new := true;
    v_previous_number := 0;
  else
    select coalesce(max(version_number), 0) into v_previous_number
      from public.environment_versions where environment_id = v_env.environment_id;
  end if;

  insert into public.environment_versions (
    version_id, environment_id, user_id, version_number, digest, bundle,
    machine_id, idempotency_key, created_at
  ) values (
    p_version_id, v_env.environment_id, p_user_id, v_previous_number + 1,
    p_digest, p_bundle, p_machine_id, p_idempotency_key, p_now
  ) returning * into v_version;

  update public.environments set latest_version_id = v_version.version_id
    where environment_id = v_env.environment_id
    returning * into v_env;

  return jsonb_build_object(
    'environment', to_jsonb(v_env),
    'version', to_jsonb(v_version),
    'created_new', v_created_new
  );
end;
$$;

-- Row Level Security --------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.cli_auth_sessions enable row level security;
alter table public.cli_tokens enable row level security;
alter table public.environments enable row level security;
alter table public.environment_versions enable row level security;
alter table public.snapshots enable row level security;
alter table public.machines enable row level security;

create policy profiles_owner_select on public.profiles
  for select using (auth.uid() = user_id);
create policy environments_owner_select on public.environments
  for select using (auth.uid() = user_id);
create policy environment_versions_owner_select on public.environment_versions
  for select using (auth.uid() = user_id);
create policy snapshots_owner_select on public.snapshots
  for select using (auth.uid() = user_id);
create policy machines_owner_select on public.machines
  for select using (auth.uid() = user_id);
-- cli_auth_sessions and cli_tokens have no policies: no browser access.

-- Private snapshot bucket ---------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('stack-snapshots', 'stack-snapshots', false)
  on conflict (id) do nothing;

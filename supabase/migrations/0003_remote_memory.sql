-- Phase 14B — remote Stack Memory (Standard + Protected Cloud backup/recovery).
--
-- Payloads (canonical bundle for Standard; ciphertext for Protected) live in the
-- private `stack-memory` storage bucket, mediated by the service role; only
-- metadata lives here. Owner-only SELECT RLS is defense-in-depth (the server
-- derives identity from the session token and uses the service role for writes).
--
-- Protected metadata carries NO project names, repo identities, filenames, logical
-- ids, or memory contents — those are inside the encrypted bundle.

-- Per-user Memory profile (privacy mode + latest committed generation) ---------
create table if not exists public.memory_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  privacy_mode text not null default 'standard'
    check (privacy_mode in ('standard', 'protected')),
  latest_generation integer,
  format_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Immutable, numbered backup generations --------------------------------------
create table if not exists public.memory_backups (
  backup_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  generation integer not null,
  parent_generation integer,
  privacy_mode text not null check (privacy_mode in ('standard', 'protected')),
  created_at timestamptz not null default now(),
  payload_locator text not null,
  payload_sha256 text not null,
  payload_bytes bigint not null,
  bundle_format_version text not null,
  crypto_version text,
  wrapped_dek jsonb,
  state text not null default 'pending'
    check (state in ('pending', 'committed', 'retired')),
  soft_deleted_at timestamptz,
  unique (user_id, generation)
);
create index if not exists memory_backups_user_state_idx
  on public.memory_backups (user_id, state);

-- Recovery-method envelopes over the MMK (opaque wrapper JSON) -----------------
create table if not exists public.memory_recovery_methods (
  method_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('passkey', 'recovery-file', 'trusted-device')),
  label text not null,
  public_identifier text,
  mmk_wrapper jsonb not null,
  crypto_version text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists memory_recovery_methods_user_idx
  on public.memory_recovery_methods (user_id) where revoked_at is null;

-- One-time CLI<->browser recovery/enrollment session relay --------------------
-- No RLS policy: service-role only, like cli_auth_sessions. The session/envelope
-- JSON is opaque public key-agreement material; the MMK is never present.
create table if not exists public.memory_recovery_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  direction text not null check (direction in ('recovery', 'enrollment')),
  session jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  envelope jsonb
);
create index if not exists memory_recovery_sessions_user_idx
  on public.memory_recovery_sessions (user_id);

-- Append-only guard: a committed generation's content is immutable. Only the
-- retire transition (state -> 'retired' + soft_deleted_at) is permitted.
create or replace function public.forbid_memory_backup_mutation()
returns trigger language plpgsql as $$
begin
  if old.state = 'committed'
     and new.state = 'retired'
     and new.backup_id = old.backup_id
     and new.user_id = old.user_id
     and new.generation = old.generation
     and new.payload_sha256 = old.payload_sha256
     and new.payload_locator is not distinct from old.payload_locator
     and new.privacy_mode = old.privacy_mode then
    return new;
  end if;
  raise exception 'memory_backups are immutable except for retiring a committed generation';
end;
$$;
drop trigger if exists memory_backups_immutable on public.memory_backups;
create trigger memory_backups_immutable
  before update on public.memory_backups
  for each row execute function public.forbid_memory_backup_mutation();

-- Atomic optimistic generation commit -----------------------------------------
-- Raises STACK_REMOTE_CONFLICT when the caller's expected parent does not match
-- the current latest committed generation (no last-writer-wins).
create or replace function public.commit_memory_generation(
  p_user_id uuid,
  p_backup_id uuid,
  p_expected_parent integer,
  p_privacy_mode text,
  p_payload_locator text,
  p_payload_sha256 text,
  p_payload_bytes bigint,
  p_bundle_format_version text,
  p_crypto_version text,
  p_wrapped_dek jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.memory_profiles;
  v_current_latest integer;
  v_generation integer;
  v_backup public.memory_backups;
begin
  select * into v_profile from public.memory_profiles
    where user_id = p_user_id for update;

  if not found then
    v_current_latest := null;
  else
    v_current_latest := v_profile.latest_generation;
  end if;

  if v_current_latest is distinct from p_expected_parent then
    raise exception 'STACK_REMOTE_CONFLICT';
  end if;

  if v_current_latest is null then
    v_generation := 0;
  else
    v_generation := v_current_latest + 1;
  end if;

  insert into public.memory_backups (
    backup_id, user_id, generation, parent_generation, privacy_mode, created_at,
    payload_locator, payload_sha256, payload_bytes, bundle_format_version,
    crypto_version, wrapped_dek, state, soft_deleted_at
  ) values (
    p_backup_id, p_user_id, v_generation, v_current_latest, p_privacy_mode, p_now,
    p_payload_locator, p_payload_sha256, p_payload_bytes, p_bundle_format_version,
    p_crypto_version, p_wrapped_dek, 'committed', null
  ) returning * into v_backup;

  insert into public.memory_profiles (
    user_id, privacy_mode, latest_generation, format_version, created_at, updated_at
  ) values (
    p_user_id,
    coalesce(v_profile.privacy_mode, 'standard'),
    v_generation,
    p_bundle_format_version,
    p_now,
    p_now
  )
  on conflict (user_id) do update
    set latest_generation = excluded.latest_generation,
        updated_at = excluded.updated_at
  returning * into v_profile;

  return jsonb_build_object('backup', to_jsonb(v_backup), 'profile', to_jsonb(v_profile));
end;
$$;

-- Row Level Security ----------------------------------------------------------
alter table public.memory_profiles enable row level security;
alter table public.memory_backups enable row level security;
alter table public.memory_recovery_methods enable row level security;
alter table public.memory_recovery_sessions enable row level security;

create policy memory_profiles_owner_select on public.memory_profiles
  for select using (auth.uid() = user_id);
create policy memory_backups_owner_select on public.memory_backups
  for select using (auth.uid() = user_id);
create policy memory_recovery_methods_owner_select on public.memory_recovery_methods
  for select using (auth.uid() = user_id);
-- memory_recovery_sessions has no policy: service-role only, no browser access.

-- Private Memory payload bucket -----------------------------------------------
insert into storage.buckets (id, name, public)
  values ('stack-memory', 'stack-memory', false)
  on conflict (id) do nothing;

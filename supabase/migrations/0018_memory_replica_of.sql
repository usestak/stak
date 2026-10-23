-- STAK-native Project Memory (Task 13 fix round 3) — server-verifiable protect replicas.
--
-- `stak memory protect` re-encrypts every Standard generation into a Protected
-- REPLICA. Each replica now records the backup_id of the Standard original it
-- replicates (`replica_of`). The Cloud server verifies that claim against this
-- account's own rows before it exempts a v1-format replica from the sticky
-- v1-after-v2 gate (see `assertCreateGenerationAllowed` in @stack/memory); this
-- column stores the verified claim, and the unique index enforces "one replica
-- per original" atomically even against a concurrent second create.
--
-- Additive only: existing rows get replica_of = null. The function body of
-- commit_memory_generation is unchanged apart from storing the new column.
--
-- Deploy safety (Task 13 fix round 4): this migration may be applied BEFORE
-- the web code that passes p_replica_of ships. The already-deployed code calls
-- commit_memory_generation with 11 NAMED arguments (PostgREST RPC); the new
-- p_replica_of is the LAST parameter with DEFAULT NULL, so that exact call
-- still resolves (named notation + default) to the one function below.
--
-- Why DROP + CREATE rather than CREATE OR REPLACE: Postgres identifies a
-- function by its argument types, so CREATE OR REPLACE with a 12th parameter
-- does not replace the 11-argument function — it adds a second overload, and
-- an 11-named-argument call would then match BOTH (one exactly, one via the
-- default) and fail with "function ... is not unique". The drop and the create
-- below are in this one migration; Postgres DDL is transactional and the
-- Supabase migration runner applies each migration file in a single
-- transaction, so no other session ever observes the moment between them.

alter table public.memory_backups
  add column if not exists replica_of uuid references public.memory_backups (backup_id);

-- One COMMITTED replica per original — the same rule as the in-memory backend
-- and `assertCreateGenerationAllowed` (which only consider committed
-- generations). A replica retired by `stak memory protect`'s recovery path
-- (an orphan another device's key can't open) leaves the index, so the
-- original can be replicated again with the current key.
create unique index if not exists memory_backups_user_replica_of_key
  on public.memory_backups (user_id, replica_of)
  where replica_of is not null and state = 'committed';

-- Append-only guard: replica_of is part of a committed generation's immutable
-- content, exactly like the other identity columns.
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
     and new.privacy_mode = old.privacy_mode
     and new.replica_of is not distinct from old.replica_of then
    return new;
  end if;
  raise exception 'memory_backups are immutable except for retiring a committed generation';
end;
$$;
revoke all on function public.forbid_memory_backup_mutation() from public, anon, authenticated;

-- Replace the 11-argument commit with ONE function whose new p_replica_of is
-- the last parameter, defaulting to null (see the deploy-safety note above).
drop function if exists public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz
);

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
  p_now timestamptz,
  p_replica_of uuid default null
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
    crypto_version, wrapped_dek, replica_of, state, soft_deleted_at
  ) values (
    p_backup_id, p_user_id, v_generation, v_current_latest, p_privacy_mode, p_now,
    p_payload_locator, p_payload_sha256, p_payload_bytes, p_bundle_format_version,
    p_crypto_version, p_wrapped_dek, p_replica_of, 'committed', null
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

-- Same privilege posture as 0007: service role only.
revoke all on function public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz, uuid
) to service_role;

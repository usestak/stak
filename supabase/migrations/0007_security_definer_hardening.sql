-- Security hardening for pre-existing SECURITY DEFINER functions (0001-0006).
--
-- This migration is security-only: it adds no table, no column, no product feature, and
-- applies cleanly to a database at migration 0006 with zero P10 schema present.
--
-- Audit of every SECURITY DEFINER function introduced by 0001 through 0006 (0004/0005/0006
-- define no functions at all):
--
--  * commit_environment_version (0001) — RPC-callable, takes p_user_id directly from the
--    caller, already has `set search_path = public` (safe), but NO REVOKE statement. A plain
--    `create function` grants EXECUTE to PUBLIC by default — in Supabase this means `anon`
--    and `authenticated` (both members of PUBLIC) could call it directly as
--    `rpc/commit_environment_version` via PostgREST with an ARBITRARY p_user_id, writing an
--    environment version attributed to any account — a full cross-account write, bypassing
--    every application-layer ownership check and RLS (SECURITY DEFINER runs as the function
--    owner, not the caller). NEEDS HARDENING. Intended caller: service role only.
--
--  * commit_public_stack_version (0002) — identical shape/gap: RPC-callable, takes
--    p_owner_user_id directly, search_path already safe, no REVOKE. NEEDS HARDENING.
--    Intended caller: service role only.
--
--  * commit_memory_generation (0003) — identical shape/gap: RPC-callable, takes p_user_id
--    directly, search_path already safe, no REVOKE. NEEDS HARDENING. Intended caller: service
--    role only. This is a privilege/authorization fix ONLY — Memory product semantics
--    (Standard vs Protected behavior, backup format, encryption, Memory IDs, generation/
--    history behavior, compatibility strings) are completely untouched; not one line of the
--    function body changes.
--
--  * forbid_version_update (0001), forbid_public_version_update (0002),
--    forbid_memory_backup_mutation (0003) — plain trigger functions, NOT security definer,
--    return type `trigger` so they are not exposed via PostgREST RPC at all.
--    TRIGGER-ONLY / NOT RPC REACHABLE. Revoked below anyway for defense-in-depth/consistency,
--    not because they are independently exploitable.
--
-- search_path: all three SECURITY DEFINER functions above already carry `set search_path =
-- public` as part of their original definition (0001/0002/0003), which is the safe,
-- non-mutable configuration — there is no unsafe/default mutable search_path to correct, so
-- no ALTER FUNCTION ... SET search_path is needed here. Confirmed by reading each function's
-- definition, not assumed.
--
-- Fixed here by restricting EXECUTE to `service_role` only — semantics are untouched, only
-- privileges change. Exact signatures are required by Postgres for a targeted REVOKE/GRANT
-- on an overloaded-capable name, so they are spelled out in full below.

revoke all on function public.commit_environment_version(
  uuid, text, jsonb, text, uuid, uuid, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.commit_environment_version(
  uuid, text, jsonb, text, uuid, uuid, uuid, uuid, uuid, timestamptz
) to service_role;
revoke all on function public.forbid_version_update() from public, anon, authenticated;

revoke all on function public.commit_public_stack_version(
  uuid, text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.commit_public_stack_version(
  uuid, text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, timestamptz
) to service_role;
revoke all on function public.forbid_public_version_update() from public, anon, authenticated;

revoke all on function public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz
) to service_role;
revoke all on function public.forbid_memory_backup_mutation() from public, anon, authenticated;

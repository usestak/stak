-- Phase P10 final lifecycle pass — reversible public sharing (unpublish/reactivate) for both
-- a shared Skill and a published named Stack, both of which are, internally, a row in
-- `public_stacks`/`public_stack_versions` (0002_public_stacks.sql). 0002 is ALREADY APPLIED
-- to real dev/prod and is never edited — every change here is additive, in this new file.
--
-- Privilege hardening for the PRE-EXISTING `commit_environment_version`/
-- `commit_public_stack_version`/`commit_memory_generation` functions now lives in
-- 0007_security_definer_hardening.sql, applicable independently of this file and of any P10
-- feature schema. This migration only hardens privileges for the two NEW functions it itself
-- creates below (`unpublish_public_stack`, `reactivate_public_stack`), which are service-role
-- only from the moment they're created, same as 0008's `commit_user_stack_version`.
--
-- One authoritative "active public share" signal, additive to the existing table: a row is
-- an ACTIVE public share iff `unpublished_at is null`. Every read path (the public owner/slug
-- page, `stak try`/`stak use @owner/slug`, the public profile listing, and the signed-in
-- app's own publication-status check) is updated in application code to honor this — see
-- `public-service.ts`. The row, every `public_stack_versions` entry, and `latest_version_id`
-- are all left untouched by unpublish; only this timestamp changes. Re-publishing reuses the
-- SAME row/slug/history (spec §10/§11) — reactivation clears the timestamp, it never inserts
-- a new `public_stacks` row.
alter table public.public_stacks
  add column if not exists unpublished_at timestamptz;

-- Owner-only, idempotent unpublish: stamps `unpublished_at` if not already set, never touches
-- `public_stack_versions`. `coalesce` makes a second call a safe no-op (keeps the FIRST
-- unpublish time) rather than sliding the timestamp forward or erroring.
create or replace function public.unpublish_public_stack(
  p_owner_user_id uuid,
  p_slug text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack public.public_stacks;
begin
  update public.public_stacks
    set unpublished_at = coalesce(unpublished_at, p_now)
    where owner_user_id = p_owner_user_id and slug = p_slug
    returning * into v_stack;
  if not found then
    return null; -- nothing at this (owner, slug) for this caller — a safe no-op, not an error
  end if;
  return to_jsonb(v_stack);
end;
$$;
revoke all on function public.unpublish_public_stack from public, anon, authenticated;
grant execute on function public.unpublish_public_stack to service_role;

-- Owner-only reactivation: clears `unpublished_at` on the SAME row (never inserts a new one),
-- restoring public visibility of its existing identity, slug, and full version history.
create or replace function public.reactivate_public_stack(
  p_owner_user_id uuid,
  p_slug text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack public.public_stacks;
begin
  update public.public_stacks
    set unpublished_at = null, updated_at = p_now
    where owner_user_id = p_owner_user_id and slug = p_slug
    returning * into v_stack;
  if not found then
    return null;
  end if;
  return to_jsonb(v_stack);
end;
$$;
revoke all on function public.reactivate_public_stack from public, anon, authenticated;
grant execute on function public.reactivate_public_stack to service_role;

-- Close the direct-anon-query gap too, not just the app's own read path: 0002's
-- `public_stacks_read`/`public_stack_versions_read` policies are `using (true)` — fully
-- public, no active-state filter — so an anon/authenticated client querying the REST API
-- directly (bypassing the app's service-layer filtering entirely) could already see an
-- unpublished row's content. Replaced so an inactive share is invisible to everyone except
-- its own owner (who may still need to read it, e.g. to resolve its own publication status).
drop policy if exists public_stacks_read on public.public_stacks;
create policy public_stacks_read on public.public_stacks
  for select using (unpublished_at is null or auth.uid() = owner_user_id);

drop policy if exists public_stack_versions_read on public.public_stack_versions;
create policy public_stack_versions_read on public.public_stack_versions
  for select using (
    exists (
      select 1 from public.public_stacks ps
      where ps.stack_id = public_stack_versions.stack_id
        and (ps.unpublished_at is null or ps.owner_user_id = auth.uid())
    )
  );

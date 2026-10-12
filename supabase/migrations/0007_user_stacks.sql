-- Phase P10B — private, account-synced Named Stacks.
--
-- A named Stack (spec: "reusable saved composition of approved Skills, private by default,
-- does not affect `main` when edited") needs an account-level registry independent of the
-- single `main` environment. Mirrors the existing `environments`/`environment_versions` pair
-- (0001_stack_cloud.sql) exactly — same shape, same append-only-version pattern, same RLS
-- posture — because that pair already proved this exact shape safe for this exact job; the
-- only semantic difference is what a row represents (a Stack-recipe bundle, not environment
-- desired state). Server code authenticates the opaque CLI/web token and derives the user
-- before using the service role; RLS below is defense-in-depth for any browser-scoped access.
--
-- Corrections (acceptance pass, never applied before this edit — see docs audit):
--  * `name` is stored already-canonicalized (trimmed, lowercased, slug-shaped, `main`
--    rejected) by the authoritative Zod schema (`userStackNameSchema`) before it ever reaches
--    this table — the unique(user_id, name) constraint below is enforcing an already-canonical
--    value, not inventing a second normalization scheme in SQL.
--  * No `idempotency_key` column: nothing in the named-Stack commit path threads a
--    client-generated key end-to-end (unlike environment_versions/public_stack_versions, whose
--    CLI callers genuinely retry-with-idempotency), so it was removed rather than shipped
--    unused.
--  * `commit_user_stack_version` is SECURITY DEFINER; EXECUTE is explicitly restricted to the
--    service role below so no anon/authenticated PostgREST caller can invoke it with an
--    arbitrary p_user_id.

create table if not exists public.user_stacks (
  stack_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  latest_version_id uuid,
  -- The public Stack slug this named Stack was last published under, or null while private
  -- (spec P10 correction §13) — lets the server resolve a truthful publication status
  -- (published / changed-since-published) on reload instead of relying on ephemeral UI
  -- state. Set by the server after a successful publish; never set by/trusted from a client.
  published_slug text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.user_stack_versions (
  version_id uuid primary key,
  stack_id uuid not null references public.user_stacks (stack_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version_number integer not null,
  digest text not null,
  bundle jsonb not null,
  created_at timestamptz not null default now(),
  unique (stack_id, version_number)
);

alter table public.user_stacks
  add constraint user_stacks_latest_version_fk
  foreign key (latest_version_id)
  references public.user_stack_versions (version_id)
  deferrable initially deferred;

-- Append-only guard: user_stack_versions may never be updated in place, matching
-- environment_versions/public_stack_versions (editing a named Stack commits a new version).
create or replace function public.forbid_user_stack_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'user_stack_versions are immutable';
end;
$$;
drop trigger if exists user_stack_versions_immutable on public.user_stack_versions;
create trigger user_stack_versions_immutable
  before update on public.user_stack_versions
  for each row execute function public.forbid_user_stack_version_update();

-- Atomic optimistic version commit — identical shape/semantics to commit_environment_version:
-- locks the (user_id, name) row, checks the caller's expected latest version, inserts a new
-- immutable version, and advances the pointer. A rename is a plain name update on the parent
-- row (no version implications); creating/removing/pausing a Skill within the Stack always
-- lands as a brand-new version via this function, never an in-place bundle edit.
create or replace function public.commit_user_stack_version(
  p_user_id uuid,
  p_name text,
  p_bundle jsonb,
  p_digest text,
  p_expected_latest_version_id uuid,
  p_stack_id uuid,
  p_version_id uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack public.user_stacks;
  v_current_latest uuid;
  v_previous_number integer;
  v_version public.user_stack_versions;
  v_created_new boolean := false;
begin
  select * into v_stack from public.user_stacks
    where user_id = p_user_id and name = p_name for update;

  if not found then
    v_current_latest := null;
  else
    v_current_latest := v_stack.latest_version_id;
  end if;

  if v_current_latest is distinct from p_expected_latest_version_id then
    raise exception 'STACK_REMOTE_CONFLICT';
  end if;

  if not found then
    insert into public.user_stacks (stack_id, user_id, name, latest_version_id, created_at)
      values (p_stack_id, p_user_id, p_name, null, p_now)
      returning * into v_stack;
    v_created_new := true;
    v_previous_number := 0;
  else
    select coalesce(max(version_number), 0) into v_previous_number
      from public.user_stack_versions where stack_id = v_stack.stack_id;
  end if;

  insert into public.user_stack_versions (
    version_id, stack_id, user_id, version_number, digest, bundle, created_at
  ) values (
    p_version_id, v_stack.stack_id, p_user_id, v_previous_number + 1,
    p_digest, p_bundle, p_now
  ) returning * into v_version;

  update public.user_stacks set latest_version_id = v_version.version_id
    where stack_id = v_stack.stack_id
    returning * into v_stack;

  return jsonb_build_object(
    'stack', to_jsonb(v_stack),
    'version', to_jsonb(v_version),
    'created_new', v_created_new
  );
end;
$$;

-- Privilege hardening: a plain `create function` grants EXECUTE to PUBLIC by default, which
-- (via PostgREST) would let an anon/authenticated client call this SECURITY DEFINER function
-- directly as `rpc/commit_user_stack_version` with an arbitrary p_user_id — a full cross-
-- account write bypassing every application-layer ownership check, RLS included (SECURITY
-- DEFINER runs as the function owner, not the caller). Only the trusted server/service-role
-- path may ever call this function.
revoke all on function public.commit_user_stack_version from public;
revoke all on function public.commit_user_stack_version from anon;
revoke all on function public.commit_user_stack_version from authenticated;
grant execute on function public.commit_user_stack_version to service_role;

revoke all on function public.forbid_user_stack_version_update from public;
revoke all on function public.forbid_user_stack_version_update from anon;
revoke all on function public.forbid_user_stack_version_update from authenticated;

-- Row Level Security — private by default, owner-only, same posture as environments.
alter table public.user_stacks enable row level security;
alter table public.user_stack_versions enable row level security;

create policy user_stacks_owner_select on public.user_stacks
  for select using (auth.uid() = user_id);
create policy user_stack_versions_owner_select on public.user_stack_versions
  for select using (auth.uid() = user_id);
-- Writes go through commit_user_stack_version (security definer, service role); no insert/
-- update/delete policy is granted to authenticated/anon, matching environment_versions.

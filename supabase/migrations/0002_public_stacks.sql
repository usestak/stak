-- Phase 9 public Stack publishing.
-- Public Stack metadata is world-readable; private Environment/snapshot tables
-- remain private (see 0001). Owner is always derived server-side from the CLI
-- token; clients never assert ownership.

-- Reserved public handles (separate from the internal auth user id) ---------
create table if not exists public.public_handles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique,
  created_at timestamptz not null default now()
);

-- Public Stacks -------------------------------------------------------------
create table if not exists public.public_stacks (
  stack_id uuid primary key,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  owner_handle text not null references public.public_handles (handle),
  slug text not null,
  display_name text not null,
  description text not null default '',
  latest_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, slug)
);
create index if not exists public_stacks_owner_handle_idx
  on public.public_stacks (owner_handle);

create table if not exists public.public_stack_versions (
  version_id uuid primary key,
  stack_id uuid not null references public.public_stacks (stack_id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  version_number integer not null,
  version_hash text not null,
  digest text not null,
  bundle jsonb not null,
  display_name text not null,
  description text not null default '',
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  unique (stack_id, version_number)
);
create unique index if not exists public_stack_versions_idempotency_idx
  on public.public_stack_versions (owner_user_id, idempotency_key)
  where idempotency_key is not null;

alter table public.public_stacks
  add constraint public_stacks_latest_version_fk
  foreign key (latest_version_id)
  references public.public_stack_versions (version_id)
  deferrable initially deferred;

-- Immutable public versions -------------------------------------------------
create or replace function public.forbid_public_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'public_stack_versions are immutable';
end;
$$;
drop trigger if exists public_stack_versions_immutable on public.public_stack_versions;
create trigger public_stack_versions_immutable
  before update on public.public_stack_versions
  for each row execute function public.forbid_public_version_update();

-- Atomic optimistic public version commit -----------------------------------
create or replace function public.commit_public_stack_version(
  p_owner_user_id uuid,
  p_owner_handle text,
  p_slug text,
  p_display_name text,
  p_description text,
  p_bundle jsonb,
  p_digest text,
  p_version_hash text,
  p_expected_latest_version_id uuid,
  p_idempotency_key uuid,
  p_stack_id uuid,
  p_version_id uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack public.public_stacks;
  v_current_latest uuid;
  v_previous_number integer;
  v_version public.public_stack_versions;
  v_created_new boolean := false;
begin
  select * into v_stack from public.public_stacks
    where owner_user_id = p_owner_user_id and slug = p_slug for update;

  if not found then
    v_current_latest := null;
  else
    v_current_latest := v_stack.latest_version_id;
  end if;

  if v_current_latest is distinct from p_expected_latest_version_id then
    raise exception 'STACK_PUBLIC_CONFLICT';
  end if;

  if not found then
    insert into public.public_stacks (
      stack_id, owner_user_id, owner_handle, slug, display_name, description,
      latest_version_id, created_at, updated_at
    ) values (
      p_stack_id, p_owner_user_id, p_owner_handle, p_slug, p_display_name,
      coalesce(p_description, ''), null, p_now, p_now
    ) returning * into v_stack;
    v_created_new := true;
    v_previous_number := 0;
  else
    select coalesce(max(version_number), 0) into v_previous_number
      from public.public_stack_versions where stack_id = v_stack.stack_id;
  end if;

  insert into public.public_stack_versions (
    version_id, stack_id, owner_user_id, version_number, version_hash, digest,
    bundle, display_name, description, idempotency_key, created_at
  ) values (
    p_version_id, v_stack.stack_id, p_owner_user_id, v_previous_number + 1,
    p_version_hash, p_digest, p_bundle, p_display_name,
    coalesce(p_description, ''), p_idempotency_key, p_now
  ) returning * into v_version;

  update public.public_stacks set
    latest_version_id = v_version.version_id,
    display_name = p_display_name,
    description = coalesce(p_description, ''),
    updated_at = p_now
    where stack_id = v_stack.stack_id
    returning * into v_stack;

  return jsonb_build_object(
    'stack', to_jsonb(v_stack),
    'version', to_jsonb(v_version),
    'created_new', v_created_new
  );
end;
$$;

-- Public read access (anonymous). Writes remain service-role only. ----------
alter table public.public_handles enable row level security;
alter table public.public_stacks enable row level security;
alter table public.public_stack_versions enable row level security;

create policy public_handles_read on public.public_handles
  for select using (true);
create policy public_stacks_read on public.public_stacks
  for select using (true);
create policy public_stack_versions_read on public.public_stack_versions
  for select using (true);

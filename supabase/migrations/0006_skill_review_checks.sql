-- 0006_skill_review_checks.sql — P5a: local-CLI-plane Skill source checking.
--
-- Backward compatible and additive: one new table, no existing column/table changes meaning.
-- Latest-only per (user_id, skill_id) — a newer `stak skill check` replaces the row; an
-- approved-base change invalidates (the service layer deletes) the row. No history is kept
-- in V0 (contract §5a).
--
-- Privacy: this table stores ONLY safe metadata (source-check state, candidate revision,
-- content hashes, a changed-file list with path/kind/binary/before-after SIZE+HASH — never
-- file text content, never a Git credential, never an absolute/home-relative path). The
-- bounded diff-relevant file TEXT content lives in the existing content-addressed blob store,
-- keyed by (user_id, artifact_payload_hash) — reused unchanged, not a new storage subsystem.
-- Writes happen through the service role; RLS grants owners read-only access.

create table if not exists public.skill_review_checks (
  user_id uuid not null references auth.users (id) on delete cascade,
  skill_id text not null,
  approved_content_hash text not null,
  source_check_state text not null
    check (source_check_state in ('no-update', 'update-available', 'cannot-check', 'check-failed')),
  checked_at timestamptz not null,

  cannot_check_reason text
    check (cannot_check_reason in ('local', 'dirty', 'ambiguous', 'unreachable', 'pinned')),
  check_failed_reason text,

  candidate_revision text,
  candidate_content_hash text,

  review_artifact_id uuid,
  artifact_payload_hash text,
  -- Changed-file list: [{ relativePath, kind, binary, before?: {byteSize,hash}, after?: {byteSize,hash} }].
  -- Never contains file text content — that lives in the blob store keyed by artifact_payload_hash.
  diff_files jsonb,

  created_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

create index if not exists skill_review_checks_owner_idx
  on public.skill_review_checks (user_id);

alter table public.skill_review_checks enable row level security;

-- Owner read-only; all writes go through the service role (account-side service logic).
create policy skill_review_checks_owner_select on public.skill_review_checks
  for select using (auth.uid() = user_id);

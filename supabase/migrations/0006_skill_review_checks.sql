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
-- bounded diff-relevant file TEXT content lives in the existing blob store, keyed by
-- (user_id, review_artifact_id) in a namespace structurally distinct from Memory snapshots
-- (which are keyed by content hash) — reused storage infrastructure, not a new subsystem.
-- Writes happen through the service role; RLS grants owners read-only access.
--
-- cannot_check_reason is reserved for intrinsic, zero-network-I/O facts about the Skill's own
-- restoration record (local/dirty/ambiguous/pinned). A failed NETWORK operation (unreachable,
-- DNS, timeout, auth) is source_check_state = 'check-failed' with a sanitized
-- check_failed_reason, never a cannot_check_reason — see docs/0.1.0-contract.md §5a.
--
-- review_unavailable_reason distinguishes a SOURCE fact (an update was found,
-- source_check_state = 'update-available') from a REVIEW CAPABILITY fact (Cloud holds no
-- reviewable artifact for it, e.g. it exceeds V0 bounds). Mutually exclusive with
-- review_artifact_id — a Skill either has a reviewable artifact or an unavailable-reason,
-- never both.

create table if not exists public.skill_review_checks (
  user_id uuid not null references auth.users (id) on delete cascade,
  skill_id text not null,
  approved_content_hash text not null,
  source_check_state text not null
    check (source_check_state in ('no-update', 'update-available', 'cannot-check', 'check-failed')),
  checked_at timestamptz not null,

  cannot_check_reason text
    check (cannot_check_reason in ('local', 'dirty', 'ambiguous', 'pinned')),
  check_failed_reason text,
  review_unavailable_reason text
    check (review_unavailable_reason in ('exceeds-review-bounds')),

  candidate_revision text,
  candidate_content_hash text,

  review_artifact_id uuid,
  artifact_payload_hash text,
  -- Changed-file list: [{ relativePath, kind, binary, before?: {byteSize,hash}, after?: {byteSize,hash} }].
  -- Never contains file text content — that lives in the blob store keyed by review_artifact_id.
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

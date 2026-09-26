# Remote Memory — Supabase Migration Review & Deployment (Phase 14B.2)

**Do NOT apply automatically.** This is a manual, reviewed step. Nothing in this
phase deploys, pushes, publishes, or applies migrations. Keep version 0.1.0.

Migration under review: `supabase/migrations/0003_remote_memory.sql`.

## 1. Review findings

Checked against the repo's conventions (`0001_stack_cloud.sql`, `0002_public_stacks.sql`):

| Item                                                                                                | Status                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables (`memory_profiles`, `memory_backups`, `memory_recovery_methods`, `memory_recovery_sessions`) | ✅ all `create table if not exists` (idempotent re-run)                                                                                       |
| Foreign keys → `auth.users(id) on delete cascade`                                                   | ✅ on every user-owned table                                                                                                                  |
| Indexes                                                                                             | ✅ `(user_id, state)` on backups; partial `(user_id) where revoked_at is null` on methods; `(user_id)` on sessions                            |
| Constraints                                                                                         | ✅ `privacy_mode`, `state`, `type`, `direction` CHECK enums; `unique(user_id, generation)`                                                    |
| Immutable-generation trigger                                                                        | ✅ `forbid_memory_backup_mutation` blocks any update except the committed→retired transition (asserts id/user/generation/hash/mode unchanged) |
| `commit_memory_generation` RPC                                                                      | ✅ optimistic concurrency via `STACK_REMOTE_CONFLICT`; advances the latest pointer + inserts atomically                                       |
| SECURITY DEFINER search_path safety                                                                 | ✅ `security definer` + `set search_path = public` (prevents search-path hijacking)                                                           |
| RLS enablement                                                                                      | ✅ enabled on all four tables                                                                                                                 |
| RLS ownership policies                                                                              | ✅ owner-`select` on profiles/backups/recovery_methods; writes are service-role only (bypass RLS), matching the existing pattern              |
| `memory_recovery_sessions` service-role-only                                                        | ✅ RLS enabled, **no policy** (no browser/anon access), like `cli_auth_sessions`                                                              |
| Private bucket                                                                                      | ✅ `stack-memory` inserted with `public=false`; no `storage.objects` policy (server-mediated, service role)                                   |
| Object path leakage                                                                                 | ✅ payload key is `mem/<userId>/<backupId>` (uuid) — no project/file identity in the path                                                     |
| Re-run / idempotency                                                                                | ✅ `create ... if not exists`, `create or replace function`, `drop trigger if exists` before create                                           |

Notes / assumptions:

- Writes rely on the **service role** (like snapshots/environments). RLS is
  defense-in-depth; the server always derives the user id from the authenticated
  token/session (`service.authenticate` / `getSessionUser`), never from a request
  field. `as_level`-style checks are not applicable here.
- The immutability trigger permits `state → retired` (+ `soft_deleted_at`) so
  migration retirement works; all content columns must be unchanged or it raises.
- Storage deletion is soft (retire) at the DB layer; the object is removed via the
  service role, but provider retention/replicas may keep bytes for a bounded window
  (disclosed in the user docs).

## 2. Exact manual deployment procedure

Prereqs: Supabase project linked; `SUPABASE_*` env configured for the web app
(`apps/web/lib/env.ts`: `supabaseUrl`, `serviceRoleKey`, `bucket`, `appUrl`,
`ticketSecret`). The Memory payload bucket name is fixed (`stack-memory`) and is
created by the migration — no new env var is required.

Option A — Supabase CLI (preferred):

```
# from the repo root, against the intended project (review the diff first!)
supabase db push
# or apply just this file in a staging project first:
supabase db execute --file supabase/migrations/0003_remote_memory.sql
```

Option B — SQL editor / psql (if not using the Supabase CLI):

```
psql "$SUPABASE_DB_URL" -f supabase/migrations/0003_remote_memory.sql
```

After applying, verify:

```
-- tables + RLS
select tablename, rowsecurity from pg_tables
  where tablename like 'memory_%';
-- policies (expect owner-select on profiles/backups/recovery_methods; none on sessions)
select tablename, policyname, cmd from pg_policies where tablename like 'memory_%';
-- the commit RPC exists and is SECURITY DEFINER
select proname, prosecdef from pg_proc where proname = 'commit_memory_generation';
-- the private bucket exists
select id, public from storage.buckets where id = 'stack-memory';
```

## 3. Rollback

The migration is additive and isolated to the `memory_*` objects. To roll back:

```
drop trigger if exists memory_backups_immutable on public.memory_backups;
drop function if exists public.forbid_memory_backup_mutation();
drop function if exists public.commit_memory_generation(
  uuid, uuid, integer, text, text, text, bigint, text, text, jsonb, timestamptz
);
drop table if exists public.memory_recovery_sessions;
drop table if exists public.memory_recovery_methods;
drop table if exists public.memory_backups;
drop table if exists public.memory_profiles;
-- optional: remove the bucket only if empty
-- delete from storage.buckets where id = 'stack-memory';
```

This does not touch any Phase 8/12 tables. No service-role secrets are printed or
required by this document; supply them only in your own shell/environment.

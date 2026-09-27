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

## 4. Live deployment + dogfood record (2026-09-26)

Migration `0003` (with `0002`) was deployed to a **linked hosted Supabase Stack
project** and Protected Memory was dogfooded end-to-end with **synthetic** data only
(no real Claude Memory). Recorded here as closure evidence.

### Infrastructure verified

- Linked hosted Supabase project; migration `0001` history repaired after remote
  schema verification; `0002` and `0003` deployed; history aligned `0001 / 0002 / 0003`.
- `stack-memory` bucket verified **private**.
- Memory tables verified **RLS enabled**; `commit_memory_generation` verified
  **SECURITY DEFINER** with a fixed `search_path`; `memory_backups` immutability
  trigger verified; recovery sessions verified **service-role mediated**.
- `supabase db push --dry-run` reports remote **up to date**.

### Dogfood A — Standard (PASS)

Synthetic project `github.com/stack-dogfood/synthetic-memory-project`, one
`CLAUDE.local.md`. Machine A (fenced HOME/STACK_HOME) → `stack login` →
`stack memory backup`: local + Standard Cloud backup succeeded; generation 0
committed; `latest_generation = 0`; no Protected crypto metadata on the Standard
generation. Machine B (fresh HOME/STACK_HOME, same Git identity at a different path)
→ `stack login` → `stack memory recover` recovered the file; `restore --dry-run`
showed 1 restorable; native restore succeeded; **SHA-256 source == restored**; a
second restore was identical/no-op.

### Dogfood B — Standard → Protected + fresh-machine recovery (PASS)

Machine A `stack memory protect --passkey` via the **production `/memory/protect`**
route (Windows · Chrome · Google Password Manager · real WebAuthn PRF). Cloud
verified: generation 0 Standard/retired/inactive; generation 1
Protected/committed/active with crypto metadata + wrapped DEK; profile Protected,
`latest_generation = 1`; recovery method `passkey` active with public identifier; no
`.stackkey` file. (The initial success-copy bug is fixed in `1096e40` — Phase 14B.3.)

Machine C (no Stack/Claude Memory, no local keys, no `CLAUDE.local.md`, no login) →
`stack login` → `stack memory recover --passkey`: CLI → production `/memory/recover`
→ Google Password Manager → real WebAuthn PRF → passkey MMK wrapper → opaque
browser/CLI bridge → Protected Cloud ciphertext → local decryption → "Memory
recovered. Privacy: Protected." **`CLAUDE.local.md` did not exist before native
restore** (proving `recover` does not bypass Phase 14A restore safety); native
restore then matched Machine A's SHA-256; a second restore was identical/no-op. Local
device state verified: `device-key.bin` + `device-mmk.json`, keys directory ACL =
current Windows principal only, full control, child inheritance.

### Post-recovery continuity + second total-loss recovery (PASS)

On Machine C after passkey recovery, the synthetic Memory was changed to V2
(`SHA-256 15C43E79C01DAAFF57B09CE73F6880010A3D2013FF89D47966CFF49246478353`).
`stack memory backup` ran with **no** browser/passkey ceremony: Privacy stayed
Protected, generation 2 committed (`parent_generation = 1`, crypto metadata +
wrapped DEK), `latest_generation = 2` — a recovered device is a normal enrolled
Protected device. Machine D (again total-loss) → `stack login` →
`stack memory recover --passkey` recovered generation 2; native restore matched the
V2 SHA-256 exactly; a second restore reported 0 ready / 1 already up to date.

### Product claim (scoped to the tested environment + supported recovery methods)

A developer can lose the original machine, sign into Stack on a fresh machine,
unlock Protected Memory with a supported recovery passkey, recover the encrypted
backup, and restore native agent Memory byte-for-byte; a recovered device then makes
normal Protected backups without a passkey ceremony each time; a later fresh machine
can recover the newer generation again.

This claim does **NOT** assert: that all passkeys support PRF; that synced-passkey
PRF is universally cross-device deterministic; protection against full local-OS-account
compromise; protection against malicious Stack-served recovery JavaScript; or strong
rollback protection after total loss of trusted local state. (See the limitations in
`memory-cloud-production.md`.)

### Dogfood findings

1. `stack memory protect --passkey` initially rendered the recovery-file wording
   despite correct Passkey state — **fixed** in `1096e40` (Phase 14B.3).
2. The `stack login` error copy suggests rerunning with `--verbose`, but `login` does
   not accept `--verbose` — **open, small CLI UX follow-up** (not fixed here to keep
   this closure scoped).

### Local dev guidance

Running `next build` while the Next.js dev server is alive can leave stale
`apps/web/.next` artifacts and cause missing-generated-chunk errors. Stop the dev
server before building, and remove `apps/web/.next` before restarting if needed.

## 5. Real Memory acceptance (2026-09-26)

The full Stack Memory V0 path was dogfooded with the user's **real Claude project
Memory** (documentation-only record; no private Memory contents or project
implementation details are reproduced here, and no payload bytes are recorded).

**Source dataset (metadata only):** Claude provider · 9 projects · 27 Memory files,
all classified `auto-memory` / project. One project had a portable Git identity
(`github.com/reymiahthesun-bit/atlas-access-flow`); the other 8 were local-only
identities. The run used the real HOME/USERPROFILE (so Stack could discover the real
Claude Memory) with an **isolated temporary STACK_HOME** (the normal Stack state was
untouched). The temporary environment enrolled into the existing Protected profile via
the existing passkey recovery method.

**Real Protected Cloud backup — PASS.** `stack memory backup` uploaded 9 projects /
27 files as **Protected** with no passkey ceremony (the source environment already
held the MMK). Cloud metadata verified: generation 3, parent 2, `privacy_mode`
protected, committed, `payload_bytes 73126`, crypto metadata + wrapped DEK present,
profile `latest_generation 3`. (Payload contents intentionally not recorded.)

**Fresh-machine recovery — PASS.** A fenced Machine E (empty HOME/STACK_HOME, no
Stack/Claude state, no login, empty Atlas repo dir with only the Git remote for the
portable identity) authenticated and ran `stack memory recover --passkey` via the real
production route + enrolled passkey: 27 files / 9 projects recovered, Privacy
Protected, native Claude Memory still absent before restore.

**Project-identity behavior — correct/safe.** `restore --dry-run --verbose` reported
**7 files ready** (the `atlas-access-flow` portable-Git-identity project) and **20
files from 8 projects not found on this machine** (the local-only identities). Stack
did **not** guess destinations for unresolved projects. Native restore: 7 restored,
20 unresolved; a second restore reported 0 ready / 7 already up to date / 20 unresolved
— **idempotent** and safe. This confirms Memory portability is now constrained mainly
by _project-identity_ portability, not Cloud recovery or encryption (see the follow-up
below).

**Semantic recall — PASS.** Claude was launched in the fresh Atlas directory (no real
source checkout beyond the Git identity) and instructed not to inspect repository
files, Git history, or external sources. It attributed its answer to saved project
memory and recalled multiple concrete project-specific details — demonstrating
functional semantic continuity, not merely filesystem restoration. (Recalled details
are intentionally not reproduced.)

**Cleanup — verified.** Claude was exited; HOME/USERPROFILE restored to the normal
profile; the temporary STACK_HOME and the whole temporary real-Memory dogfood
directory were deleted (`Test-Path` → False). The Protected Cloud generation is
intentionally retained as the user's real encrypted backup.

### Acceptance statement

**Stack Memory V0 is accepted for the tested environment and supported
provider/recovery path.** Real evidence now exists for: native Claude Memory
discovery; local private backup; Standard Cloud backup/recovery; Standard→Protected
migration; real WebAuthn PRF passkey protection; fresh-machine Protected recovery;
normal Protected backup after recovery; a second synthetic total-loss recovery; a real
27-file Protected Cloud backup; real fresh-machine recovery; portable Git project
identity matching; safe unresolved-project handling; native restore idempotency; actual
Claude semantic recall after restore; and temporary plaintext/device-state cleanup.

**Product claim (scoped to the tested environment + supported provider/recovery
path):** Stack can preserve supported Claude project Memory, protect it with
client-side encryption, recover it on a fresh machine through a supported passkey
recovery flow, map Memory back to a project with a portable identity, restore it into
Claude's native Memory structure, and let Claude continue with prior project context.

### Known limitations (unchanged, plus identity portability)

- Not all passkeys support PRF; synced-passkey PRF cross-device determinism is not
  guaranteed.
- Protected mode does not defend against full local-OS-account compromise, nor against
  malicious Stack-served recovery JavaScript (V0 browser trust boundary).
- Strong rollback detection after complete loss of all trusted local state is not
  guaranteed.
- **Local-only project identities are not automatically portable across machines** —
  Memory for such projects recovers to the private store but cannot be auto-mapped to a
  native destination without a portable identity.

### Follow-up (not implemented here): Portable Project Identity & Recovery Mapping

Allow a local-only project from an old machine to be safely matched or explicitly
mapped to its equivalent on a new machine without absolute filesystem paths and without
silent guessing. Possible future mechanisms: Git identity where available, explicit
project aliases, recovery-time project mapping, and user confirmation for ambiguous
matches. Not designed or implemented in this phase.

### Clarification (2026-09-27, added in Phase 15A)

The original counts above are unchanged and accurate: 7 files restored, 20 files from 8
projects retained as not found on this machine. A later review refined the
_interpretation_ of the unresolved set — it is not proof that all 8 projects were
identity-portability failures. At least one of them (**Nexus**) had actually been
**intentionally deleted** locally before the dogfood, and others may also no longer exist
on this machine. So the 20 unresolved files represented a **mixture** of unknown
machine-availability and lifecycle states — projects with no portable identity, projects
not checked out on this machine, and projects deleted locally — rather than a single
identity failure. Stack correctly wrote nothing for all of them. Phase 15A separates these
dimensions; see [`project-identity.md`](./project-identity.md),
[`project-lifecycle.md`](./project-lifecycle.md), and
[`project-recovery-mapping.md`](./project-recovery-mapping.md).

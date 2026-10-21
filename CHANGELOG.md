# Changelog

All notable changes to STAK are documented here. This project adheres to
semantic versioning.

## 0.2.0-beta.2 — 2026-10-21

- **Fixed:** `stak use`/`stak try` crashed with a raw, unhandled stack trace
  instead of a readable error when a required Skill's name collided with
  something already required — now resolved automatically instead of
  blocking: the newly-added Skill is kept under a name disambiguated by its
  originating Stack (e.g. `shared` becomes `second-shared`) rather than
  forcing you to drop one or the other. Applies to the local, public/remote,
  and owned `use` paths, and to `try`.
- **Fixed:** a public Stack published with an empty description could never
  be read back — `stak use`/`stak try` against it failed with a schema error
  instead of a usable message. Publishing with an empty description is now
  rejected up front, with a clear reason, instead of producing an unreadable
  published Stack.
- **Performance:** `stak scan`/`stak status`/`stak init` no longer spawn a
  `git` subprocess for every Skill location that clearly isn't in a Git
  repository — a cheap in-process check runs first, and `git` is only
  invoked when it's actually needed. Real-world case (31 unique Skills
  duplicated across 62 locations, none Git-backed): dropped from ~17s to
  well under a second.

## 0.2.0-beta.1 — 2026-10-20

A Git-like mental model for the everyday STAK workflow: `stak status`,
`stak add <skill>` / `stak add .`, `stak push`, `stak pull` — no separate
commit step; `push` creates an immutable Cloud checkpoint from whatever was
staged.

- **Git-like workflow** — `stak status` reports untracked/modified Skills and
  unstaged Memory; `stak add` stages Skills and Memory onto `main`; `stak push`
  uploads exactly what's staged (never implicitly re-staging native Memory) and
  never creates a duplicate Cloud generation when nothing changed.
- **Unified Skills + Memory Cloud sync** — combined push/pull reporting and
  Cloud sync status (including an honest "unavailable" state instead of a
  silent failure).
- **Stable logical Project identity** — Memory is addressed by a durable
  Project identity, not a machine-encoded path: local-only Project mapping,
  Git-backed Project reconciliation, fresh-machine Memory recovery, and
  relocated/re-cloned Project Memory normalization (idempotent staging and
  restore, fail-closed on genuine conflicts — never a silent merge or pick).
- **Legacy environment Cloud bundle compatibility** — older Cloud environment
  bundles remain readable.

This beta covers Skills for Claude / Cursor / Codex, and Claude-native project
Memory portability across machines. It does not claim cross-agent Memory
portability.

## 0.1.1 — 2026-10-18

- fix(cli): reuse normal Cursor `agent login` sessions in isolated trials
- fix(cli): support Cursor Agent shims on Windows
- fix(cli): satisfy multi-agent trial lint
- fix(cli): tighten multi-agent trial diagnostics

## 0.1.0 — 2026-10-14

First V0 release: the core "my agent setup is portable" thesis,
end to end.

### Added — environment portability

- **Discovery** — `stak scan` reads Skills across Codex, Cursor, and Claude Code
  roots without mutating anything.
- **Desired state** — `stak init` captures the `main` Environment; `stak status`
  and `stak diff` show drift.
- **Content Store** — immutable, content-addressed preservation and hash-verified
  restoration.
- **Agents** — `stak run codex|cursor|claude` projects `main` into agent
  directories with shared physical binding ownership (`~/.agents/skills` for
  Codex and Cursor; `~/.claude/skills` for Claude) and unmanaged-content
  protection.
- **Composition** — `stak use`/`stak remove` compose local stacks safely;
  removal preserves Skills still required elsewhere.
- **Isolated trials** — `stak try <stack> -- codex` runs a stack in a fenced
  scratch workspace with a temporary HOME/`CODEX_HOME`; `main` is untouched.
- **Cloud portability** — `stak login`/`logout`/`whoami`, and `stak push`/`pull`
  back up and reconstruct the private portable `main` across machines with
  matching Skill hashes, private snapshot transport, and exact Git reference
  reacquisition.
- **Public stacks** — `stak publish` creates immutable, content-hash snapshot
  public stacks addressed as `@owner/name`; `stak use @owner/name` and
  `stak try @owner/name -- codex` consume them. Public reads never expose private
  Environments or snapshots.
- **Distribution** — the CLI is bundled into a single self-contained binary.

### Added — private agent Memory

- **Capture & restore** — `stak memory scan`/`backup`/`restore` back up Claude's
  private agent Memory into STAK's content-addressed private store and restore it
  without overwriting existing native files (allowlist-only; no transcripts,
  history, env, sessions, or tokens).
- **Standard vs Protected** — `stak memory protect` enables client-side encrypted
  (Protected) Cloud backup; Standard is private/authenticated Cloud storage.
- **Recovery** — `stak memory recover` with a passkey or a `.stackkey` recovery
  file; Protected Memory is unrecoverable without one (no backdoor).
- **Backup history** — immutable, numbered backups; `stak memory history` and
  `stak memory recover --backup <n>` recover a previous backup; superseding a
  newer backup requires confirmation.
- **Preservation-first composition** — a backup never silently drops Memory: the
  private store is the baseline and the native scan overlays it, so Memory absent
  from the native scan is retained (absence is not deletion).

### Added — logical projects

- **Portable Project identity** — stable, opaque Project IDs that survive
  backup/recovery across machines; strong Git identity; machine-local directory
  bindings that never cross machines.
- **Mapping** — `stak project map` explicitly authorizes a local directory as a
  recovered project's restore destination (ambiguity fails closed).
- **Lifecycle** — `stak project archive`/`unarchive` manage an `active`/`archived`
  lifecycle that is independent of machine availability; archive preserves identity
  and Memory; the selected backup's lifecycle is authoritative on recovery.

### Changed — rebrand to STAK

- Product renamed **Stack → STAK**; CLI executable **`stack` → `stak`**; public
  package **`@stack/cli` → `@usestak/cli`** (MIT licensed). The reusable domain
  object is still a "stack" (`stak use <stack>`, `stack.yaml`, public stacks).
  Persisted identifiers, crypto/format constants, `.stackkey`, `STACK_HOME`, and
  internal `@stack/*` package names are unchanged.

### Deferred from V0.1

`stak switch` (only `main` exists), isolated `try` for Cursor/Claude,
automatic stack updates, force conflict overrides, hard Memory deletion /
`forget`, teams/organizations, and marketplace features.

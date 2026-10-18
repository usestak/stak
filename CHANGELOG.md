# Changelog

All notable changes to STAK are documented here. This project adheres to
semantic versioning.

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
- **Public stacks** — `stak publish` creates reference-only public stacks
  addressed as `@owner/name`; `stak use @owner/name` and
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

`stak switch` (only `main` exists), isolated `try` for Cursor/Claude, public
snapshot publishing, automatic stack updates, force conflict overrides, hard
Memory deletion / `forget`, teams/organizations, and marketplace features.

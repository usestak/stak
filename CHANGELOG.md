# Changelog

All notable changes to STAK are documented here. This project adheres to
semantic versioning.

## 0.2.0-beta.4 — 2026-10-28

- **Shared memory across agents (#23):** `stak run codex` / `stak run cursor`
  (or `stak memory agents enable`) shares your project Memory with Codex (a
  private `AGENTS.override.md` that includes your team's `AGENTS.md`) and
  Cursor (`.cursor/rules/stak-memory.mdc`). The files stay out of Git via the
  repo's local ignore list, and are refreshed automatically after
  `stak add .`, `pull`, `push` and the other Memory commands.
  `stak memory agents` lists, enables, disables and resets this per agent.
  `stak status` shows a line per agent. Your own `AGENTS.md`, your Cursor
  rules and anything you edited by hand are never touched. Sharing is
  one-way for now: edits made in Codex or Cursor don't flow back.
- **Privacy fix (#23):** when STAK restores your `CLAUDE.local.md` into a
  project on another machine, it now keeps it out of Git as well.
- **#21:** after `stak pull` on a new machine, Skills show as "not installed
  here yet — run `stak run <agent>`" instead of "missing", and status no
  longer suggests `stak remove`.
- **#20:** the hint after `stak memory recover` is accurate (`stak pull` for
  project Memory). A hanging npm registry no longer slows every command.
  `recover --passkey` prints the project-merge line.
- **#19:** a Windows fix, so Skills containing symlinks restore correctly on
  Windows. CI is now green on Windows, Linux and macOS.

## 0.2.0-beta.3 — 2026-10-27

- **STAK-native Project Memory.** Project Memory is now stored by STAK
  itself, under a stable Project ID, in its own neutral layout — Claude Code
  is a two-way adapter on top of it rather than the source of truth. Memory
  syncs between machines through a three-way merge that stops on real
  conflicts instead of silently picking a side or overwriting.
  - New commands to work through a conflict by hand: `stak memory resolve`,
    `stak memory diff`, and `stak memory materialize`.
  - Local Memory stores on the older format upgrade automatically, with a
    write-once backup first.
  - `stak pull` now always syncs Project Memory, even on an established
    machine with no Skills changes to bring down.
  - Two Project IDs that turn out to be the same repository now fold their
    Memory together automatically instead of leaving it split.
  - Every command that changes Memory now takes turns through a lock, so
    overlapping commands can't corrupt it; `stak memory unlock` clears a
    lock left behind by a crashed or killed process.
  - Hardened `stak memory protect` against being left in a half-finished
    state.
  - **Upgrade note:** once your account has Memory in the new format, older
    CLIs are refused when they try to push Memory to it. Update with
    `npm i -g @memstk/cli@beta`.
- **Update notifications.** STAK now tells you when a new version is
  available (at most once a day, never in scripts/CI/`--json`; opt out with
  `STAK_NO_UPDATE_CHECK=1`), and `stak upgrade` installs it.
- **Fixed (security):** Skill archive extraction could be made to write or
  link outside the Skill's own folder. Archives are untrusted input reached
  through `stak use`, `stak try`, and `stak pull`. Entries whose path
  contains `:`, and file names that differ from another entry only by case,
  are now rejected outright.
- **Fixed:** a fresh-machine `stak pull` with no Cloud Memory yet was
  reported as a failure; it's now treated as the normal, expected case.
- **Fixed:** `stak push` on a Machine reached through a symlink lost Git
  provenance for Git-backed Skills and republished them as snapshots instead
  of references.
- **Performance:** `stak push` makes fewer round trips to Cloud — Skills and
  Memory now upload concurrently (Memory still holds its lock), confirmed
  content from a prior push is no longer re-checked, uploads run with
  bounded concurrency, and auth token bookkeeping is throttled instead of
  written on every request.
- **Performance:** the web dashboard navigates faster — pages show a loading
  skeleton immediately instead of a blank screen, and several per-page round
  trips were removed.

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

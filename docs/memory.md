# Memory

Stack preserves two different things:

- **Skills** — reusable capabilities. Potentially shareable, and publishable as
  reference-only public Stacks.
- **Memory** — the private, durable context an agent has learned or remembers.
  Always private; **never** shareable and never reachable from public publishing.

```
Stack
├── shareable
│   └── Skills
└── private
    └── Memory
```

Memory is treated as potentially secret-bearing. No public manifest, public
version, public snapshot preparation, or `stack publish` traversal ever touches
Memory storage, which lives in its own private namespace under
`$STACK_HOME/memory/` (content-addressed objects + an atomically committed
manifest), separate from the Skill store.

## What Stack Memory V0 preserves (Claude)

Only these allowlisted, durable surfaces are captured, each classified explicitly:

| Classification                 | Source (read-only)                          |
| ------------------------------ | ------------------------------------------- |
| `user-instructions`            | `~/.claude/CLAUDE.md`                       |
| `agent-memory` (global)        | `~/.claude/agent-memory/<agent>/**`         |
| `auto-memory` (project)        | `~/.claude/projects/<key>/memory/**`        |
| `agent-memory` (project)       | `<project>/.claude/agent-memory/<agent>/**` |
| `project-private-instructions` | `<project>/CLAUDE.local.md`                 |

Claude is the only Memory provider in V0. Codex and Cursor are not faked: Codex
has no native auto-memory directory, and Cursor account User Rules already sync
through Cursor while local `~/.cursor/rules` are a separate instruction surface —
adapters for them may register later and report `unsupported` until a stable
contract exists.

## What Stack Memory V0 does NOT preserve

Stack Memory is **not** "all agent history" or a "complete agent brain." It does
not capture, and never backs up:

- session `*.jsonl` transcripts, prompt history, tool-result archives
- file-history / checkpoint data, plans, tasks/todos
- debug logs, stats, paste/image caches, shell snapshots, session/env state
- OAuth data, authentication tokens, API keys, `.env` files, `~/.claude.json`
- settings containing credentials or environment secrets, plugin caches
- arbitrary files merely because they live under `~/.claude`

Discovery is allowlist-based (only the paths above are traversed), never follows
symlinks out of a memory root, and validates every path segment.

## Project identity

Project memory is keyed by a portable **project identity**, preferring the
canonical Git remote (`github.com/owner/repo`, normalized across https/ssh forms,
`.git` suffixes, host casing, and with any credentials stripped) rather than an
absolute filesystem path. So a project cloned to a different directory on another
machine is still recognized. When no portable Git identity exists, the identity
is `local` and unresolved, and restore must rebind it to a real local project;
if the project is not present, restore reports it as **not available on this
machine** rather than inventing a destination. Absolute source paths are
machine-local metadata and never appear in the portable manifest.

### Logical projects and Project IDs

Each project Stack knows about has a stable, opaque **Project ID**
(`prj_…`) — a random identifier that stays the same no matter how the folder is
renamed, moved, or cloned, and that never encodes a path, username, machine, or
folder name. A logical project can carry identity claims (its canonical Git
remote, and a compatibility reference for older path-derived identities), a
machine-local binding to a directory on _this_ machine, and a **lifecycle** state
(`active` or `archived`).

- **`stack project`** lists the logical projects Stack knows, grouped by lifecycle
  (ACTIVE / ARCHIVED), each with its identity, whether it is available on this
  machine, how many memory files it has, and any mapping. It never shows memory
  contents.
- **`stack project map <project> <directory>`** authorizes a directory on this
  machine as the restore destination for a recovered project. This is a
  **machine-local binding only** — it does not turn the directory's path into a
  shared/portable identity, and it never silently merges two projects. If the
  directory is a different Git repository than the project, the map is refused
  (repository transfers are not reconciled automatically yet). Mapping never changes
  a project's lifecycle.
- **`stack project archive <project>`** / **`stack project unarchive <project>`**
  set a project's lifecycle. See "Archiving a project" below.

**Active vs archived.** Lifecycle is your organizational stance on a project and is
**independent of availability**. All four combinations are valid: active+available,
active+unavailable, archived+available, archived+unavailable. A missing directory
does **not** archive a project, and an archived project becoming available does
**not** reactivate it — the two are separate.

**Why a project can stay "not available on this machine."** After recovering on a
fresh machine, a project without a portable Git identity has no automatic
destination. Stack keeps its memory safely in the private store and simply reports
it as unavailable — recovered memory does not need a destination to be preserved.
Map it later with `stack project map`, or leave it; Stack will not nag or guess.

**Why Stack won't restore based on an old path.** A recovered legacy project is
never auto-restored just because a directory happens to sit at the same path it
once used. Paths get reused for unrelated projects, so an old path is treated only
as a weak hint — restoring there requires an explicit `stack project map` (or an
independent strong Git identity). This prevents one project's memory from leaking
into another.

**When a mapping becomes portable.** Project IDs and identity claims travel to the
Cloud **inside your next Memory backup** — there is no separate project-sync
service. So after you map or identify a project, run `stack memory backup` to
capture the updated registry; a later recovery on another machine then sees the
same Project IDs. Machine-local bindings (the actual directory paths) are **never**
uploaded.

**Standard vs Protected registry privacy.** The portable project registry rides
inside the Memory bundle, so it follows the same privacy mode as the rest of your
Memory: in **Protected** mode it is client-side encrypted and the Stack server
never sees your Project IDs, Git identities, or claims; in **Standard** mode it is
server-readable exactly like the rest of a Standard backup. Filesystem paths and
bindings stay on your machine in either mode.

**Archiving a project.** `stack project archive <project>` marks a project archived;
`stack project unarchive <project>` returns it to active. Archive is **reversible**
and is purely organizational:

- It **preserves everything** — the Project ID, identity claims, Memory, backup
  history, recoverability, and any local binding. It is **not** a delete (there is no
  `stack project delete`; hard deletion is out of scope).
- Archived projects still appear in `stack project` (grouped under ARCHIVED) and
  their Memory is still backed up and still carried forward when unavailable — the
  same preservation rules apply regardless of lifecycle.
- Availability is independent: mapping or Git-resolving an archived project makes it
  available **without** unarchiving it.
- Like other registry changes, a lifecycle change is **local until your next
  `stack memory backup`**, which snapshots it into the portable registry; a later
  recovery on a fresh machine then reproduces the same lifecycle (with **no** local
  bindings crossing). Recovering an older backup reproduces the lifecycle that backup
  held. Backups made before this feature recover as **active**.

_Not yet available:_ deleting a project's memory (hard delete), an optional in-repo
project marker, and repository-transfer reconciliation are designed in the
architecture docs but not implemented in this release.

## Backup and restore

- `stack memory scan` — read-only discovery of portable memory. Changes nothing.
- `stack memory backup [--dry-run]` — copies allowlisted memory into the private
  store and commits the manifest last. Read-only against native agent state: it
  never modifies, reformats, deletes, or invokes Claude. A failed backup leaves
  the previous backup valid and commits nothing. `--dry-run` previews the backup
  composition (native + carried-forward counts, final total, privacy mode) without
  writing anything, creating a Cloud backup, or touching the registry.
- `stack memory status` — shows the last backup.
- `stack memory restore [--dry-run]` — resolves, previews, and applies. It only
  writes to **absent** targets; an existing target with different content is a
  **conflict** that is reported and left untouched (V0 never merges memory or
  lets an agent resolve conflicts). Identical targets are no-ops. Unmanaged
  memory absent from a backup is never deleted.

Default output stays beginner-friendly (no hashes, object paths, vendor keys, or
absolute paths). Use `--verbose` for diagnostics and `--json` for stable
structured output.

### Backup continuity for unavailable projects

A backup **preserves previously recovered Memory that belongs to projects which are
not available on this machine.** After recovering on a fresh machine, only the
projects you can resolve here (a Git-backed project, or one you `stack project map`)
appear in your native agent Memory; the rest stay safely in Stack's private store.
The next `stack memory backup` **carries those unresolved files forward unchanged**
into the new backup — it does not drop them just because they aren't checked out
here. So a machine that natively holds 9 files but recovered 27 still backs up 27.

- **Unavailable is not deleted.** Absence from the native scan (or a project that
  isn't checked out here) is never treated as a deletion signal for unresolved
  projects; preservation is preferred over silent loss.
- Carried-forward Memory stays **private inside Stack** — it is not restored into
  Claude, no directories are created, no machine bindings are made, and old paths do
  not become authoritative. Mappings you make remain machine-local.
- For projects that **are** available here, your current native Memory is the source
  (a changed file's current version wins), matching the existing model.
- Use `stack memory backup --dry-run` to see the composition (native vs
  carried-forward vs final) before creating a new backup.
- There is **no archive or delete** yet: intentionally removing one old project's
  Memory is deferred to later lifecycle/deletion design.

## Cloud backup & recovery

Once you `stack login`, `stack memory backup` also protects your Memory in Stack
Cloud so it survives losing this machine. Local backup always happens first and
never depends on the Cloud — if you are signed out, or the Cloud is unreachable,
the local backup still succeeds and Stack says so calmly.

There are **two privacy modes**, both fully private (per-user, never shared, never
public):

- **Standard** (default) — the simplest option. Your Memory is backed up privately
  to Stack Cloud with authenticated access, TLS, strict per-user authorization, and
  encryption at rest. Recovery on a new machine needs nothing but `stack login`.
  Standard is **not** end-to-end encrypted: Stack's infrastructure is technically
  capable of reading a Standard backup.
- **Protected** — opt-in client-side encryption. Your Memory is encrypted on your
  device before it leaves it; Stack Cloud stores only ciphertext and can never read
  it. Recovery needs a recovery method (a passkey or a recovery file).

### Commands

- `stack memory backup` — local backup, then Cloud backup when signed in. Same
  command for both modes; the complexity stays under the hood. On the first
  Standard Cloud backup Stack shows `Privacy: Standard` and how to upgrade.
- `stack memory protect` — turn on Protected mode once. Creates your encryption key,
  sets up a recovery method (recovery file today; passkey via the browser), enrolls
  this device so future backups need no prompt, and safely migrates existing
  Standard backups to Protected (verify-before-delete).
- `stack memory history [--json]` — list your recoverable **backups** (newest first)
  with backup number, date, privacy mode, and size.
- `stack memory recover [--backup <n>] [--recovery-file <path>]` — rebuild the
  private Memory **store** from Cloud on a new machine. It never writes native agent
  files — run `stack memory restore` afterward for that.
- `stack memory status` — shows local and Cloud state (privacy mode, recovery
  methods, whether this device is enrolled, and whether local Memory came from an
  earlier backup than the Cloud latest).

`recover` (Cloud → Stack's private store) is deliberately separate from `restore`
(private store → native agent files); `restore` keeps all Phase 14A conflict
protection.

### Backup history & recovering a previous backup

Every Cloud backup is **immutable and numbered**. `stack memory recover` recovers the
**latest** backup by default. You can inspect the history with `stack memory history`
and recover a specific earlier one with `stack memory recover --backup <n>` — useful
when the latest backup contains unwanted state but an earlier backup is known-good.

- Historical recovery changes only your **local** private Memory store. It does
  **not** change the latest Cloud backup, retire newer backups, or upload anything.
  You still run `stack memory restore` to apply it to native agent Memory.
- After recovering a previous backup, `stack memory status` shows the relationship
  (e.g. "Local source Backup #3 / Cloud latest Backup #4") instead of "up to date".
- If you then `stack memory backup`, Stack creates a **new** backup from your current
  local Memory. Cloud history is linear, so the new backup is added after your current
  latest backup (e.g. backup #5 after #4) and becomes the new latest — superseding it.
  The older backup stays available in your backup history. Because this supersedes a
  newer backup, Stack **asks for confirmation** first (`--dry-run` previews it; pass
  `--yes` in non-interactive use).
- Machine bindings and recovery provenance are machine-local — they never cross
  machines or enter a backup.

> **Terminology.** Stack presents its immutable Memory backups to users as
> **backups**. The **public CLI — including `--json` output — uses backup terminology
> only** (`backups[].backup`, `--backup <n>`, `Backup #N`). Internally (the domain
> types, the database columns, the Cloud RPC, and the architecture docs) they are still
> called _generations_; that model is unchanged and translated to backups at the CLI
> boundary. `stack memory generations` and `recover --generation <n>` remain as
> **hidden** aliases that accept the old invocation syntax but return the same modern
> backup JSON. These aliases are a pre-release convenience and are not promised as a
> permanent compatibility contract.

### Recovery methods (Protected)

- **Recovery file** (`stack-memory-recovery.stackkey`) — a high-entropy secret,
  generated on your device, saved once (never stored in Stack Cloud). Keep it in a
  password manager or secure storage. **Anyone with this file can recover your
  Memory; it is not secure by itself.** You don't memorize it.
- **Passkey** — uses your passkey's WebAuthn PRF to unlock your Memory in the
  browser. Requires a passkey provider that supports PRF; if PRF is unavailable
  Stack tells you precisely and offers the recovery file instead.

Each recovery method independently unlocks the **same** Memory Master Key, so you
can have several (e.g. a passkey per device plus a recovery file) and remove one
without affecting the others. **If you lose every recovery method, Protected Memory
is unrecoverable — Stack has no backdoor.**

### Important properties

- **Account compromise:** a stolen Stack account can retrieve _Standard_ Memory,
  but cannot decrypt _Protected_ Memory without a valid recovery method or an
  enrolled device.
- **No silent downgrade:** if your account is Protected but this device can't unlock
  it, the Cloud backup fails closed — Stack never uploads readable Memory as a
  fallback.
- **Browser trust limit:** the passkey ceremony runs Stack-served JavaScript; it is
  not defended against Stack shipping malicious client code (documented, accepted
  for V0).
- **Local device key:** an enrolled device stores your Memory Master Key in an
  owner-only (0600) envelope under `$STACK_HOME/memory/keys/`. This keeps Stack
  Cloud blind, but does **not** defend against full compromise of your local OS
  account; OS-native secure storage is future hardening.
- **Deletion:** retiring old Standard backups after migration is a soft-delete;
  provider retention means bytes may persist for a bounded window.
- **Rollback:** backups are immutable, numbered generations with optimistic
  concurrency (no last-writer-wins). A brand-new device after total loss cannot, by
  itself, detect a provider serving a valid-but-stale backup without an external
  trusted anchor — a documented V0 limitation.

Crypto internals (key hierarchy, envelope formats, the CLI↔browser bridge, the
Cloud schema) are in
[`architecture/memory-cloud-production.md`](./architecture/memory-cloud-production.md).

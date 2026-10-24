# Memory

STAK preserves two different things:

- **Skills** — reusable capabilities. Potentially shareable, and publishable
  as immutable, content-addressed snapshot public Stacks.
- **Memory** — the private, durable context an agent has learned or remembers.
  Always private; **never** shareable and never reachable from public publishing.

```
STAK
├── shareable
│   └── Skills
└── private
    └── Memory
```

Memory is treated as potentially secret-bearing. No public manifest, public
version, public snapshot preparation, or `stak publish` traversal ever touches
Memory storage, which lives in its own private namespace under
`$STAK_HOME/memory/` (content-addressed objects + an atomically committed
manifest), separate from the Skill store.

## What STAK Memory V0 preserves (Claude)

Only these allowlisted, durable surfaces are captured, each classified explicitly.
STAK still reads the same files, but the three project rows (`auto-memory`
project, `agent-memory` project, `project-private-instructions`) now end up in
STAK's own Project Memory (see "Canonical Project Memory" below) instead of a
copy of Claude's folder layout:

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

## What STAK Memory V0 does NOT preserve

STAK Memory is **not** "all agent history" or a "complete agent brain." It does
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

Each project STAK knows about has a stable, opaque **Project ID**
(`prj_…`) — a random identifier that stays the same no matter how the folder is
renamed, moved, or cloned, and that never encodes a path, username, machine, or
folder name. A logical project can carry identity claims (its canonical Git
remote, and a compatibility reference for older path-derived identities), a
machine-local binding to a directory on _this_ machine, and a **lifecycle** state
(`active` or `archived`).

- **`stak project`** lists the logical projects STAK knows, grouped by lifecycle
  (ACTIVE / ARCHIVED), each with its identity, whether it is available on this
  machine, how many memory files it has, and any mapping. It never shows memory
  contents.
- **`stak project map <project> <directory>`** authorizes a directory on this
  machine as the restore destination for a recovered project. This is a
  **machine-local binding only** — it does not turn the directory's path into a
  shared/portable identity, and it never silently merges two projects. If the
  directory is a different Git repository than the project, the map is refused
  (repository transfers are not reconciled automatically yet). Mapping never changes
  a project's lifecycle.
- **`stak project archive <project>`** / **`stak project unarchive <project>`**
  set a project's lifecycle. See "Archiving a project" below.

**Active vs archived.** Lifecycle is your organizational stance on a project and is
**independent of availability**. All four combinations are valid: active+available,
active+unavailable, archived+available, archived+unavailable. A missing directory
does **not** archive a project, and an archived project becoming available does
**not** reactivate it — the two are separate.

**Why a project can stay "not available on this machine."** After recovering on a
fresh machine, a project without a portable Git identity has no automatic
destination. STAK keeps its memory safely in the private store and simply reports
it as unavailable — recovered memory does not need a destination to be preserved.
Map it later with `stak project map`, or leave it; STAK will not nag or guess.

**Why STAK won't restore based on an old path.** A recovered legacy project is
never auto-restored just because a directory happens to sit at the same path it
once used. Paths get reused for unrelated projects, so an old path is treated only
as a weak hint — restoring there requires an explicit `stak project map` (or an
independent strong Git identity). This prevents one project's memory from leaking
into another.

**When a mapping becomes portable.** Project IDs and identity claims travel to the
Cloud **inside your next Memory backup** — there is no separate project-sync
service. So after you map or identify a project, run `stak memory backup` to
capture the updated registry; a later recovery on another machine then sees the
same Project IDs. Machine-local bindings (the actual directory paths) are **never**
uploaded.

**Standard vs Protected registry privacy.** The portable project registry rides
inside the Memory bundle, so it follows the same privacy mode as the rest of your
Memory: in **Protected** mode it is client-side encrypted and the STAK server
never sees your Project IDs, Git identities, or claims; in **Standard** mode it is
server-readable exactly like the rest of a Standard backup. Filesystem paths and
bindings stay on your machine in either mode.

**Archiving a project.** `stak project archive <project>` marks a project archived;
`stak project unarchive <project>` returns it to active. Archive is **reversible**
and is purely organizational:

- It **preserves everything** — the Project ID, identity claims, Memory, backup
  history, recoverability, and any local binding. It is **not** a delete (there is no
  `stak project delete`; hard deletion is out of scope).
- Archived projects still appear in `stak project` (grouped under ARCHIVED) and
  their Memory is still backed up and still carried forward when unavailable — the
  same preservation rules apply regardless of lifecycle.
- Availability is independent: mapping or Git-resolving an archived project makes it
  available **without** unarchiving it.
- Like other registry changes, a lifecycle change is **local until your next
  `stak memory backup`**, which snapshots it into the portable registry; a later
  recovery on a fresh machine then reproduces the same lifecycle (with **no** local
  bindings crossing). Backups made before this feature recover as **active**.
- An explicit **recovery makes the selected backup authoritative** for lifecycle.
  Recovering backup #N restores the lifecycle that backup #N held — even for a project
  you already have locally, and even if your current local state differs. So if you
  archive a project locally but have **not** backed it up, deliberately recovering an
  older backup can replace that unbacked change with the older backup's lifecycle. Your
  machine-local **directory bindings stay local and are untouched** by this; only the
  portable lifecycle follows the selected backup.

_Not yet available:_ deleting a project's memory (hard delete), an optional in-repo
project marker, and repository-transfer reconciliation are designed in the
architecture docs but not implemented in this release. Also not yet available:
Cursor and Codex Memory adapters, a User (global) Memory scope, and rename
detection (a renamed Memory file counts as one deletion plus one new file).

## Canonical Project Memory

STAK now owns each project's Memory itself, in its own format that belongs to no
single agent. A project's Memory is a set of Markdown documents keyed by its
**Project ID**, not by Claude's folder naming, so moving or re-cloning a project
doesn't change its Memory. STAK keeps every document's bytes exactly as written.
Documents live in three areas:

- `notes/…` — project knowledge: facts, decisions, workflows. Claude's
  `MEMORY.md` index is simply `notes/MEMORY.md`.
- `instructions/private.md` — private recurring instructions for this project
  (Claude's `CLAUDE.local.md`).
- `agents/<agent>/…` — Memory that truly belongs to one agent; only that
  agent's adapter writes it out.

Claude is a two-way **adapter**. It keeps writing its own memory files during
sessions, exactly as before, and those files work like a Git working copy:
`stak add .` takes your edits into STAK Memory, and `stak pull` / `stak push`
write changes from other machines back out to Claude's files. STAK only
overwrites an agent file that hasn't changed since the last sync, so an edit you
haven't added is never silently replaced. A missing Memory folder is treated as
"never written here", not as "deleted everything".

`stak status` also reports, per project, Memory changes not added yet and any
pending Memory sync conflicts.

**Selecting a project.** Commands that take a `<project>` accept its Project ID
or any unique prefix of one (as shown by `stak project`).

### Conflicts between machines

When two machines change the same Memory document differently (or one edits it
while the other deletes it), push and pull stop and list the conflicts. Until
they are resolved, `stak push`, `stak pull` and `stak memory backup` stop with
"Resolve the listed conflicts, then push again". No Memory is pushed in the
meantime, but your Skills still push as normal.

- `stak memory resolve` — with no arguments, lists the pending conflicts. With
  `<project> <path> --keep local|cloud|both`, resolves one.
- `stak memory diff <project> <path>` — shows both versions of one conflict.
  This is the only command that prints Memory content.
- `stak memory materialize [project] [--agent claude]` — rebuilds an agent's
  Memory files from STAK Memory (for example after deleting `~/.claude`), for
  every project on this machine or just one.

Your choices take effect when the **last** conflict is resolved: STAK Memory is
updated, Claude's files are rewritten where safe, and the next `stak push`
publishes the result. **Keep both** keeps Cloud's version at the original name
and saves yours next to it as `<name>.conflict-<hash>.<ext>` (the hash comes from
your version's content, so every machine picks the same name).

A resolution belongs to the exact Cloud version it was made against. If Cloud
moves on before you finish, or Memory changes locally at a path you already
resolved (for example after `stak add .`), STAK says the merge has gone stale.
Run `stak push` (or `stak pull`) to merge again; earlier choices are listed again
and need to be redone. Old decisions are never replayed blindly.

`stak memory materialize` only writes to projects found on this machine. A
project known only from another machine shows as **not available on this
machine** until the next `stak pull` finds it, or until you map it with
`stak project map`.

### `stak memory backup` and recovering an older version

`stak memory backup` is now the Memory part of `stak push`: it merges with Cloud
the same way and never overwrites another machine's changes. It is kept as a
deprecated alias.

After `stak memory recover --backup <n>`, your local Memory is that older backup,
and the rollback shows up as ordinary local changes, including deletions. Cloud
history is never rewritten. `stak push` refuses while local Memory comes from an
older backup than Cloud's latest; run `stak memory backup` (it asks you to
confirm) to make the rollback the newest backup.

### After "Delete Cloud Memory"

After you delete your Cloud Memory (web app Settings → "Delete Cloud Memory"),
the next push from any machine uploads that
machine's Memory again. A machine whose last sync happened before the delete may
see conflicts to resolve when it next syncs.

### Upgrading from the old format

The first time this CLI touches Memory (`stak status`, `stak add`, `stak push`
or `stak pull`), it upgrades your local store to the new format, once and
automatically. There is nothing to do and nothing is lost:

- A copy of the old manifest is kept at
  `$STAK_HOME/memory/manifests/current.v1-premigration.json` and never
  overwritten.
- Memory files that were missing from Claude's folders at upgrade time are
  restored from STAK, never recorded as deletions.
- Duplicate copies left over from older versions are merged when identical; when
  they differ, all are kept using the "keep both" naming.
- If the upgrade is interrupted, the next run finishes it.

Once an account has Memory in the new format, older CLIs are refused with:
"This account's Memory was upgraded by a newer STAK CLI. Update with
`npm i -g @memstk/cli@beta`."

## Backup and restore

- `stak memory scan` — read-only discovery of portable memory. Changes nothing.
- `stak memory backup [--dry-run]` — copies allowlisted memory into the private
  store and commits the manifest last. Read-only against native agent state: it
  never modifies, reformats, deletes, or invokes Claude. A failed backup leaves
  the previous backup valid and commits nothing. `--dry-run` previews the backup
  composition (native + carried-forward counts, final total, privacy mode) without
  writing anything, creating a Cloud backup, or touching the registry.
- `stak memory status` — shows the last backup.
- `stak memory restore [--dry-run]` — resolves, previews, and applies. It only
  writes to **absent** targets; an existing target with different content is a
  **conflict** that is reported and left untouched (V0 never merges memory or
  lets an agent resolve conflicts). Identical targets are no-ops. Unmanaged
  memory absent from a backup is never deleted.

Default output stays beginner-friendly (no hashes, object paths, vendor keys, or
absolute paths). Use `--verbose` for diagnostics and `--json` for stable
structured output.

### Backups are preservation-first

**STAK backups are preservation-first: a missing native Memory file is never treated
as a deletion.** Your current STAK private Memory store is the **baseline** for the
next backup, and the current native agent Memory scan is an **overlay** on top of it:

- Every previous Memory item **not observed** in the native scan is **retained
  unchanged**. This holds regardless of whether its project is available, unavailable,
  Git-resolved, explicitly mapped, **active, or archived** — availability and lifecycle
  never authorize deletion.
- Where the native scan **does** observe an item (matched by its logical Memory
  identity, after project-identity resolution), the **native version wins**: a changed
  file contributes its new content, an identical file is reused, and a genuinely new
  native file is **added**.
- So a machine that recovered 27 files but currently scans 0 native files still backs
  up **27** — including an available project (e.g. a Git-backed one) whose recovered
  Memory has not yet been restored into native storage. It is not reduced to only the
  files present natively.

Carried-forward Memory stays **private inside STAK** — it is not restored into Claude,
no directories are created, no machine bindings are made, and old paths do not become
authoritative. Mappings you make remain machine-local. Content is content-addressed, so
retained items reuse their existing objects and hashes.

Use `stak memory backup --dry-run` to see the composition before creating a backup: it
distinguishes **projects available on this machine**, **native memory files found**, and
the **previous memory files preserved** (split into those from available projects not
currently present natively, and those from projects not available here).

**Absence is not deletion (intentional V0 tradeoff).** Because native absence is never a
deletion signal, this can retain stale Memory until an explicit removal mechanism exists.
There is **no archive-as-delete and no `stak memory forget`/delete** yet: intentionally
removing a project's Memory needs a separate explicit design later. Silent loss is worse
than conservative retention, so preservation wins.

## Cloud backup & recovery

Once you `stak login`, `stak memory backup` also protects your Memory in STAK
Cloud so it survives losing this machine. Local backup always happens first and
never depends on the Cloud — if you are signed out, or the Cloud is unreachable,
the local backup still succeeds and STAK says so calmly.

There are **two privacy modes**, both fully private (per-user, never shared, never
public):

- **Standard** (default) — the simplest option. Your Memory is backed up privately
  to STAK Cloud with authenticated access, TLS, strict per-user authorization, and
  encryption at rest. Recovery on a new machine needs nothing but `stak login`.
  Standard is **not** end-to-end encrypted: STAK's infrastructure is technically
  capable of reading a Standard backup.
- **Protected** — opt-in client-side encryption. Your Memory is encrypted on your
  device before it leaves it; STAK Cloud stores only ciphertext and can never read
  it. Recovery needs a recovery method (a passkey or a recovery file).

### Commands

- `stak memory backup` — local backup, then Cloud backup when signed in (now the
  Memory part of `stak push`, kept as a deprecated alias; see "Canonical
  Project Memory" above). Same
  command for both modes; the complexity stays under the hood. On the first
  Standard Cloud backup STAK shows `Privacy: Standard` and how to upgrade.
- `stak memory protect` — turn on Protected mode once. Creates your encryption key,
  sets up a recovery method (recovery file today; passkey via the browser), enrolls
  this device so future backups need no prompt, and safely migrates existing
  Standard backups to Protected (verify-before-delete).
- `stak memory history [--json]` — list your recoverable **backups** (newest first)
  with backup number, date, privacy mode, and size.
- `stak memory recover [--backup <n>] [--recovery-file <path>]` — rebuild the
  private Memory **store** from Cloud on a new machine. It never writes native agent
  files — run `stak memory restore` afterward for that.
- `stak memory status` — shows local and Cloud state (privacy mode, recovery
  methods, whether this device is enrolled, and whether local Memory came from an
  earlier backup than the Cloud latest).

`recover` (Cloud → STAK's private store) is deliberately separate from `restore`
(private store → native agent files); `restore` keeps all Phase 14A conflict
protection.

### Backup history & recovering a previous backup

Every Cloud backup is **immutable and numbered**. `stak memory recover` recovers the
**latest** backup by default. You can inspect the history with `stak memory history`
and recover a specific earlier one with `stak memory recover --backup <n>` — useful
when the latest backup contains unwanted state but an earlier backup is known-good.

- Historical recovery changes only your **local** private Memory store. It does
  **not** change the latest Cloud backup, retire newer backups, or upload anything.
  You still run `stak memory restore` to apply it to native agent Memory.
- After recovering a previous backup, `stak memory status` shows the relationship
  (e.g. "Local source Backup #3 / Cloud latest Backup #4") instead of "up to date".
- If you then `stak memory backup`, STAK creates a **new** backup from your current
  local Memory. Cloud history is linear, so the new backup is added after your current
  latest backup (e.g. backup #5 after #4) and becomes the new latest — superseding it.
  The older backup stays available in your backup history. Because this supersedes a
  newer backup, STAK **asks for confirmation** first (`--dry-run` previews it; pass
  `--yes` in non-interactive use).
- Machine bindings and recovery provenance are machine-local — they never cross
  machines or enter a backup.

> **Terminology.** STAK presents its immutable Memory backups to users as
> **backups**. The **public CLI — including `--json` output — uses backup terminology
> only** (`backups[].backup`, `--backup <n>`, `Backup #N`). Internally (the domain
> types, the database columns, the Cloud RPC, and the architecture docs) they are still
> called _generations_; that model is unchanged and translated to backups at the CLI
> boundary. `stak memory generations` and `recover --generation <n>` remain as
> **hidden** aliases that accept the old invocation syntax but return the same modern
> backup JSON. These aliases are a pre-release convenience and are not promised as a
> permanent compatibility contract.

### Recovery methods (Protected)

- **Recovery file** (`stack-memory-recovery.stackkey`) — a high-entropy secret,
  generated on your device, saved once (never stored in STAK Cloud). Keep it in a
  password manager or secure storage. **Anyone with this file can recover your
  Memory; it is not secure by itself.** You don't memorize it.
- **Passkey** — uses your passkey's WebAuthn PRF to unlock your Memory in the
  browser. Requires a passkey provider that supports PRF; if PRF is unavailable
  STAK tells you precisely and offers the recovery file instead.

Each recovery method independently unlocks the **same** Memory Master Key, so you
can have several (e.g. a passkey per device plus a recovery file) and remove one
without affecting the others. **If you lose every recovery method, Protected Memory
is unrecoverable — STAK has no backdoor.**

### Important properties

- **Account compromise:** a stolen STAK account can retrieve _Standard_ Memory,
  but cannot decrypt _Protected_ Memory without a valid recovery method or an
  enrolled device.
- **No silent downgrade:** if your account is Protected but this device can't unlock
  it, the Cloud backup fails closed — STAK never uploads readable Memory as a
  fallback.
- **Browser trust limit:** the passkey ceremony runs STAK-served JavaScript; it is
  not defended against STAK shipping malicious client code (documented, accepted
  for V0).
- **Local device key:** an enrolled device stores your Memory Master Key in an
  owner-only (0600) envelope under `$STAK_HOME/memory/keys/`. This keeps STAK
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

# STAK-native Project Memory — Design

**Date:** 2026-10-22
**Status:** Approved design, awaiting final spec review. Not yet implemented.
**Release target:** a new `@beta` CLI release (not `latest`), on the road to 1.0.

---

## 1. The idea in one paragraph

Today STAK *moves Claude's memory around*: it copies the memory files Claude Code
writes and puts them back on another machine. For 1.0, STAK should *own* each
project's memory itself, in its own format that doesn't belong to any one agent.
Claude, Cursor and Codex then become **adapters**: they read from and write to
STAK's copy, but STAK's copy is the real one. A project's memory belongs to the
**STAK Project**, not to a folder, a machine, or a coding agent.

```
Today:   Claude memory  ──STAK copies it──▶  Claude memory (another machine)

1.0:                 ┌──▶ Claude files
        STAK Memory ─┼──▶ Cursor files   (later)
                     └──▶ Codex files    (later)
```

## 2. Why

- **Moving a project shouldn't change its memory.** Today memory is keyed by
  Claude's folder naming, which is based on the folder path. Moving or re-cloning a
  project needed special fixes (2026-10-20) to avoid duplicates.
- **Switching agents shouldn't lose memory.** If memory only exists in Claude's
  format, Cursor and Codex can never share it.
- **STAK already has the right identity.** Every project already has a stable
  Project ID (`prj_…`) that never depends on paths or agents. Memory just isn't
  stored under it yet. This design finishes that job.

## 3. Scope

**In this design**

- STAK's own format for project memory.
- The Claude adapter, working in both directions (import from Claude, write back to
  Claude).
- Upgrading existing users' stored memory and old Cloud versions.
- Syncing between machines, including what happens when two machines disagree.
- The adapter interface that Cursor and Codex adapters will use later.

**Not in this design**

- **Cursor and Codex adapters.** Each gets its own short spec once this ships.
- **Global (non-project) memory.** `~/.claude/CLAUDE.md` and global agent memory
  keep working exactly as today, backed up the old way. A "User Memory" design can
  come later.
- **Smart features** like rename detection, summarizing memory, or splitting it into
  individual facts. The identity model leaves room for these, but they aren't built
  now.

**What memory should and shouldn't contain**

Memory holds durable project knowledge: facts, conventions, decisions, architecture
context, workflows, constraints, recurring instructions. It is **not** a dump of
conversations, terminal history or repository files. The same allowlist as today
applies: transcripts, caches, settings and credentials are never captured.

## 4. Key ideas

### 4.1 A memory is a document

Each project's memory is a set of **Markdown documents**. STAK keeps every
document's bytes exactly as written. It never reformats, rewrites, or "cleans up"
content. A document may have frontmatter with a `type` (for example `fact`,
`decision`, `workflow`, `constraint`). STAK reads it to show in the CLI and web app,
but never requires or edits it.

### 4.2 How a document is identified

A document is identified by exactly two things:

> **(Project ID, STAK path)**, for example `(prj_7k2…, notes/auth-decisions.md)`

The STAK path belongs to STAK's own layout, not to any agent's folders. There are
three areas:

| STAK area | What goes there | Shared across agents? |
|---|---|---|
| `notes/…` | Project knowledge: facts, decisions, workflows | **Yes** |
| `instructions/private.md` | Private recurring instructions for this project | **Yes** |
| `agents/<agent>/…` | Memory that genuinely belongs to one specific agent | **No.** Only that agent's adapter writes it out |

Rule: anything meant to work across Claude, Cursor and Codex lives in `notes/` or
`instructions/`. `agents/` is reserved for truly agent-specific memory and is never
the normal place for project knowledge.

Because the identity is just "project + path", two machines that create the same
file independently end up with the same document automatically. **Renames** count
as "delete the old path, add the new one". A later version may detect renames, and
that won't change this identity model.

### 4.2.1 When two Project IDs turn out to be the same project (addition, 2026-10-26)

Two machines can each create a Project ID for the same repository before they
sync. STAK Cloud then reports that the repository is already known under another ID
(its Git-based reconciliation), and the machine adopts that ID. When this happens,
STAK **merges the two projects into one**: the ID Cloud uses (the *surviving* ID)
keeps everything, and the other ID (the *former* ID) becomes an alias of it.

What every machine does, in the same way:

- **It remembers the alias.** The surviving project's record lists its former IDs.
  Former IDs travel in the registry snapshot, so every machine learns them, including
  machines that never got the reconciliation from Cloud themselves.
- **It folds Memory filed under a former ID into the surviving ID** before any sync
  decision. It does this in its own Memory, in its merge base, in any pending merge,
  in its projection, and in every Cloud version it reads. Because all three sides of
  every merge are folded first, the rename never looks like a deletion.
- **The fold rules** are deterministic, so every machine gets the same result:
  - A document only the former ID has moves to the surviving ID at the same path.
  - The same path with the same content becomes one document.
  - The same path with different content keeps the surviving ID's version at the
    path and the former ID's version at the keep-both path
    (`<stem>.conflict-<hash>.<ext>`, as in §8.3). Nothing is lost, and the user is
    told.
  - A present document beats a deletion of the same path, so a fold never deletes
    content.
  - Afterwards the former ID holds nothing.
- **Agent files are never deleted or rewritten by a fold.** Both IDs point at the
  same project folder, so only STAK's bookkeeping changes; the files on disk stay as
  they are.
- **Chains resolve.** If A became B and B became C, everything ends up under C.
  When one fold merges several former IDs, they are folded in Project ID order,
  so the same input always gives the same result. One rare case remains (review
  note, 2026-10-27): when three or more IDs hold *different* content at the same
  path and machines learn the aliases in different orders (for example A→C
  before B→C on one machine, both at once on another), which former version
  keeps the original path can differ, and an extra `.conflict-<hash>` copy can
  appear. Nothing is ever lost — every version is kept at some path — and the
  extra copy is an ordinary file the user can delete.
- **Only trusted aliases are learned** (review fix, 2026-10-27). A former ID
  listed in a Cloud snapshot is believed only when this machine's record of it
  shares a claim with the surviving record (the same Git repository, or the same
  legacy folder claim) and is not bound to a different folder. Anything else is
  ignored, so a corrupted snapshot can never retire an unrelated project. (This guards
  against corruption and client bugs, not a hostile server: in Standard mode a server
  that can forge a snapshot could already forge Memory itself. Protected mode keeps
  the snapshot encrypted.)
- **The user sees one line**, for example: "Merged project prj_rvznx… into prj_4f68…
  (same repository); 1 file kept both."

The same fold applies when a project's identity strengthens from a local folder to a
Git repository (an older local-only ID adopted into the Git-identified one).

### 4.3 Agent files are a working copy

This works like Git:

| Git | STAK Memory |
|---|---|
| Your working folder | The agent's own memory files (for example Claude's) |
| The committed history | STAK Memory |
| `git status` / `git add` | `stak status` shows agent edits; `stak add` takes them into STAK Memory |
| `git pull` / checkout | `stak pull` / `stak use` write STAK Memory back out to the agents |

Claude keeps writing its memory files during sessions, just as it does today.
Nothing about Claude's behavior changes. The `stak add` step is what keeps memory
**intentional**: nothing becomes official STAK Memory until you add it.

### 4.4 Adapters only translate

An adapter does exactly two jobs:

1. **Read**: list the agent's memory files for a project and say which STAK path
   each one corresponds to.
2. **Write**: put given documents into the agent's files, or remove them.

Adapters **never decide anything**. Every decision (what changed, what's safe to
overwrite, what's a conflict) is made in one shared place, the sync engine, so every
agent behaves the same way.

### 4.5 Where Claude's files map to

| STAK path | Claude file on this machine |
|---|---|
| `notes/<file>` | `~/.claude/projects/<Claude's folder key>/memory/<file>` |
| `agents/<agent>/<file>` | `<project folder>/.claude/agent-memory/<agent>/<file>` |
| `instructions/private.md` | `<project folder>/CLAUDE.local.md` |

Claude's `MEMORY.md` index is simply the document `notes/MEMORY.md`.

**Moved projects:** when reading, STAK looks at *every* Claude folder that belongs
to the same project, including folders left behind at old locations. Identical
copies count once. Copies that differ are a conflict. When writing, STAK writes
**only to the project's current location**, so old folders are read for
reconciliation but never kept up to date.

**Projects not on this machine:** their memory is kept safely in STAK and reported as
"not available on this machine". Nothing is written anywhere until the project is
mapped (`stak project map`), the same as today.

## 5. What it looks like day to day

**Normal work**

1. You work in Claude Code. Claude updates its memory files.
2. `stak status` shows something like `2 Memory changes not added`.
3. `stak add .` takes them into STAK Memory.
4. `stak push` sends them to STAK Cloud.

**Second machine**

1. `stak pull` brings down the latest STAK Memory.
2. STAK writes it into Claude's files for each project that exists on this machine.
3. If you edited a memory file here and haven't added it yet, STAK **won't overwrite
   it**. It tells you instead.

This is new: today `stak pull` only touches memory on a brand-new machine. Because of
the safety rules below, it can now safely update established machines too.

**Regenerating agent files**

`stak memory materialize [--agent claude]` rebuilds an agent's memory files from
STAK Memory, for example after you deleted `~/.claude` or switched machines.

## 6. How STAK knows what changed

For every document, STAK compares three fingerprints:

- **Agent copy**: what's in the agent's file right now.
- **Last synced**: what that file contained the last time STAK imported or wrote it.
- **STAK copy**: what STAK Memory currently says.

| Situation | What it means | What STAK does |
|---|---|---|
| All three match | Nothing changed | Nothing |
| Only the agent copy changed | You (or Claude) edited the file | Shown in `stak status`; `stak add` takes it in |
| Only the STAK copy changed | New memory came from another machine | `stak pull` / `stak use` write it to the file |
| Both changed to the same thing | They already agree | Just record that they're in sync |
| Both changed differently | A local conflict | You choose: keep the agent's version, keep STAK's, or keep both |
| Agent file deleted | You deleted that memory | `stak add` records the deletion |
| STAK deleted it, file untouched | Deleted on another machine | `stak pull` removes the file |
| STAK deleted it, file edited | Edit vs delete | Conflict |
| First time seeing both, and they differ | E.g. a fresh machine that already had files | Conflict (identical copies are just accepted) |

### Two safety rules that are never broken

1. **STAK only overwrites an agent file if it hasn't changed since the last sync.**
   An edit you haven't added can never be silently replaced.
2. **A missing folder is not a mass delete.** If an agent's whole memory folder for a
   project is gone, STAK treats it as "never written to this machine", not "you
   deleted everything". Use `stak memory materialize` to rebuild it.

## 7. Deletions are recorded, not guessed

When a document is deleted, STAK keeps a small **deletion record** (a "tombstone")
with the path and a fingerprint of the last content. STAK never treats a missing
entry as a deletion. Deletion records are kept permanently in this version. They're
tiny, and keeping them avoids ambiguity.

One extra rule: if an agent file's content exactly matches something that was
deleted, STAK **won't bring it back** as new memory. This stops old folders and old
machines from quietly reviving deleted memory.

## 8. Syncing between machines

### 8.1 Cloud versions

Every `stak push` creates a new, permanent Cloud version containing all of your
memory, the same as today. Standard and Protected privacy modes work exactly as now.
In Protected mode everything is encrypted before it leaves your machine, so **all
merging happens in the CLI, never on the server.**

### 8.2 Pushing

STAK remembers which Cloud version this machine last synced with (its **base**).

- **Nobody else pushed since:** your changes simply become the next version.
- **Another machine pushed since:** STAK downloads that version and merges
  document by document:
  - Changed on one side only → that change is used.
  - Changed the same way on both sides → fine.
  - Changed differently on both sides, or edited on one side and deleted on the
    other → **conflict**.
- **No conflicts:** the merged result becomes the next version, and any changes from
  the other machine are written to your agent files (following the safety rules).
- **Any conflict:** **no memory is pushed at all** until you resolve it. Your Skills
  still push as normal.
- **Two machines pushing at the same moment:** the Cloud accepts only one. The other
  machine re-merges against the new version automatically, up to 3 attempts, then
  asks you to try again.

**If the CLI crashes right after a successful push**, before it saves its new base:
on the next push STAK sees that the Cloud's latest version already contains exactly
what this machine has. It recognizes the earlier push succeeded, fixes its base, and
**does not create a duplicate version.**

### 8.3 Resolving a conflict

```
stak memory diff <project> <path>                         # see both versions (opt-in)
stak memory resolve <project> <path> --keep local|cloud|both
stak push
```

- **Keep both:** the Cloud version keeps the original name. Yours is saved next to it
  as `<name>.conflict-<code>.md`, where `<code>` is built from your version's
  content (12 characters, longer only if that name is somehow taken). Because the
  name comes from the content, any machine resolving the same conflict picks the
  same name.
- **A resolution belongs to the exact Cloud version it was made against.** If the
  Cloud moves on again before you push, STAK merges again against the newer version.
  Anything that changed again shows up as a fresh conflict. Old decisions are never
  replayed blindly.

### 8.4 Pulling

- **No unpushed local changes:** you get the latest version, written to your agent
  files.
- **Unpushed local changes:** STAK merges in the same way as push, but uploads
  nothing.

### 8.5 Recovering an old version

`stak memory recover --generation N` makes version N your local memory. The Cloud's
history isn't rewritten. Instead, the rollback appears as ordinary local changes
(including deletions), and your next `stak push` makes it the newest version. It's a
deliberate, visible rollback.

## 9. Upgrading existing users

### 9.1 Your local memory (automatic, one time)

The first time the new CLI touches memory (`status`, `add`, `push` or `pull`), it
upgrades the local store. This needs no network and is safe to run repeatedly.

1. **Back up** the old manifest to `current.v1-premigration.json`. This file is
   written once and **never overwritten** by later runs.
2. **Convert** each project memory file into a STAK document (project + STAK path),
   using the existing Project registry.
3. **Old duplicates** (the same memory stored under several old folder keys, left
   over from earlier bugs): identical copies become one. Different copies are
   **all kept** using the "keep both" naming, with the most recently captured one
   keeping the original name. The upgrade summary lists them. This is not an error.
4. **Mark everything as last synced**, so edits you made since your last `stak add`
   show up as normal changes, not as a wall of conflicts.
5. **Slim down the old manifest** so it only holds global memory.

**If it's interrupted**, the next run checks every step in order and repairs whatever
is incomplete:

```
backup exists?
→ STAK Memory exists?
→ every "last synced" record exists and matches the expected starting value?
→ old manifest reduced to global-only?
```

It never skips ahead just because a later file exists.

### 9.2 Old Cloud versions

Old Cloud versions are **never changed**. When STAK needs one (to start the first
merge after upgrading, or for `stak memory recover`), it converts it on the fly.

The conversion gives the same result on every machine **whenever that version
includes its project registry snapshot**, which is true of every version created
since the project registry was introduced (Phase 15B). Older versions don't have one.
For those, STAK falls back to the local registry, so they keep today's limitation:
two machines may disagree on Project IDs until Git-based reconciliation links them.

### 9.3 People still on an older beta CLI

- Once an account has pushed with the new format, the server **refuses pushes in the
  old format**, with the message:
  > "This account's Memory was upgraded by a newer STAK CLI. Update with
  > `npm i -g @memstk/cli@beta`."

  (This says `@beta` because `latest` intentionally stays at 0.1.2. It switches to
  `@latest` at 1.0.)
- An old CLI that tries to *read* a new-format version fails safely before changing
  anything on the machine.
- `stak memory backup` stays as a **deprecated alias** for the memory part of
  `stak push`.

### 9.4 Server and web app

Very little changes. The server already records each version's format. It needs to:

- refuse old-format pushes after an upgrade (above), and
- read per-project memory counts from new-format Standard versions. This gets
  simpler, because documents are already grouped by project.

Protected accounts are unaffected: the server still can't read them.

## 10. If something goes wrong

**Crashes.** Every STAK file is replaced in one atomic step, and steps run in a
fixed order. Because of the fingerprint comparison in section 6, an interrupted
`pull` or `use` fixes itself on the next run: files already written are recognized
as in sync, and files not yet written get written. Push crashes are handled as in
8.2, migration crashes as in 9.1.

**Errors you might see.** Every error stops the command **before** anything is
changed:

| Error | Meaning |
|---|---|
| Merge pending | Resolve the listed conflicts, then push again |
| Cloud keeps moving | Three merge attempts lost the race; try again |
| Name clash | Two documents differ only by upper/lower case and can't both exist on this filesystem |
| Project not on this machine | Map it with `stak project map` before writing it out |
| Upgrade can't continue | A genuinely broken old entry (for example a missing content file or a path that can't be converted). Ordinary differing duplicates are **not** errors |
| Unsupported version | This CLI is too old for the account's memory |

Any damaged file, failed fingerprint check or decryption problem stops the command
without changing anything.

**Privacy.** CLI output shows project names and STAK paths, never memory content. The
only command that shows content is the explicit, opt-in `stak memory diff`. Sync
bookkeeping files stay on this machine and are never uploaded.

## 11. Testing

- **Change detection:** one test per row of the table in section 6, plus both safety
  rules and the "don't revive deleted memory" rule.
- **Merging:** one-sided changes, identical changes, real conflicts, edit vs delete;
  "keep both" picks the same name on two simulated machines; a resolution conflicts
  again if the Cloud moved on.
- **Converting old versions:** real old bundles from `fixtures/`, with and without a
  registry snapshot; identical results across two different machines when the
  snapshot is present.
- **Upgrade:** running twice changes nothing; the backup is never overwritten; an
  interruption at *each* step is repaired; the starting "last synced" values turn
  later edits into normal changes.
- **Claude adapter:** both mapping directions; old folders read but never written;
  symlinks refused; upper/lower-case clashes on Windows.
- **Two-machine Cloud scenarios** (using the existing in-memory test Cloud):
  - simple push; simultaneous pushes with automatic retry
  - conflict → resolve → Cloud moves on → merge again
  - recovering an old version, then pushing it forward
  - Protected-mode merging
  - **crash after a successful push:**
    ```
    push succeeds → crash before saving base → restart → push
    → no extra Cloud version is created → base is repaired
    ```
- **Server:** old-format pushes refused after upgrade, with the `@beta` message;
  project counts read correctly from the new format; an old CLI fails safely on new
  versions.
- **Real-world dogfood before release:** a moved project, a second machine, then
  publish on `@beta`.

## 12. Done when

- A project's memory has **one stable STAK identity** that doesn't depend on Claude
  Code.
- Moving a project to another folder or machine **doesn't change** its memory's
  identity.
- An agent's memory files can be **regenerated** from STAK Memory.
- Existing users are upgraded automatically, with nothing lost, and old CLIs can't
  damage upgraded accounts.

## 13. Later (separate designs)

- Cursor adapter, then Codex adapter.
- A global "User Memory" area.
- Rename detection by fingerprint.
- Cleaning up deletion records.
- Optional structure on top of documents (individual facts and decisions).

---

## Appendix A: Technical reference (for implementers)

### A.1 Files (under `$STAK_HOME/memory/`)

| File | Uploaded? | Purpose |
|---|---|---|
| `canonical/main.json` | Yes (in bundle) | STAK Memory: `{ schemaVersion: 2, projects: [{ projectId, documents: [Doc] }] }` |
| `canonical/base.json` | No | Last synced Cloud generation number + its canonical manifest (merge base) |
| `canonical/merge.json` | No | Pending merge: `basedOnGeneration`, merged-so-far, conflict list |
| `projections/<adapter>.json` | No | Per `(projectId, path)`: last imported/written native hash |
| `objects/` | Yes (in bundle) | Existing content-addressed store, reused |
| `manifests/current.json` | Yes (in bundle) | Existing v1 manifest, global items only after migration |
| `manifests/current.v1-premigration.json` | No | Write-once (`wx`) pre-migration backup |

`Doc` is either `{ path, state: 'present', contentHash, importedFrom, importedAt }`
or `{ path, state: 'deleted', lastContentHash, deletedAt }`.
Paths: `/`-separated, NFC, validated by `validateTreePath`, compared case-sensitively.
No machine paths, vendor keys or Git remotes in `main.json` (identity claims stay in
the existing registry snapshot). New machine-local files are added to the exclusion
lists in `packages/core/src/state.ts` and the bundle codec.

### A.2 The three hashes

N = native (agent copy), P = projection (last synced), C = canonical (STAK copy).
Section 6's table is the N/P/C state table. Invariants: overwrite native only when
N = P. An absent adapter project root means "not materialized", not "deleted". A
native hash equal to a tombstone's `lastContentHash` is never imported as new.

### A.3 Interfaces

```ts
interface ProjectMemoryAdapter {
  readonly id: 'claude';                     // later 'cursor' | 'codex'
  readonly namespaces: readonly Namespace[]; // claude: notes, instructions, agents
  detect(): Promise<Detection>;
  scan(project: BoundProject): Promise<NativeDoc[]>; // { canonicalPath, bytes, locator }
  write(project: BoundProject, ops: MaterializeOp[]): Promise<WriteResult>;
}
```

`locator` (the native absolute path) only exists in memory while a command runs and is
never persisted to a portable file. All decisions live in `canonical/sync.ts` (the N/P/C
engine) and `canonical/merge.ts` (the three-way merge). The existing `MemoryAdapter`
remains for global memory only.

### A.4 Push algorithm

1. Read L (local `main`), B (`base`, generation g), R (Cloud latest, generation r).
2. If R is semantically identical to L (same canonical digest): base ← R, stop. No
   new generation. (Repairs a crash after a successful `createGeneration`.)
3. If r = g: `createGeneration(L, expectedParent: r)`, then base ← L.
4. If r > g: fetch and decrypt R, `merge(B, L, R)`. If there are conflicts, write
   `merge.json` (with `basedOnGeneration: r`) and stop with no generation created.
   Otherwise `createGeneration(M, expectedParent: r)`, set main and base ← M, then
   materialize incoming changes (N = P rule).
5. On a `conflict` error from `createGeneration`, go back to step 1 (at most 3
   attempts total), then `cloud-moved-retry-exhausted`.

**Base after the v1 → v2 upgrade (clarification, 2026-10-23).** Local migration seeds
`base.json` from the Cloud generation this machine last pushed or recovered in v1
(converted with `convertV1Bundle`), when that generation is known. The first push then
merges normally against it. If it is not known, B stays empty and differing documents
surface as conflicts (safe; never silently prefer either side). The Cloud latest is
never assumed to be this machine's base.

Resolution writes the chosen content into L and sets the merge base to r; a later push
against r′ > r re-merges (base r, L, R′).

Keep-both name: `<stem>.conflict-<h>.<ext>`, where h = the first 12 hex characters of
the local version's content hash (extend to 16, then to the full hash, on collision).
The Cloud version keeps the original path. In migration duplicates, the latest
`capturedAt` keeps the original path.

### A.5 Bundle and server

- New bundle format `stack-mem-bundle-v2`: canonical `main.json`, registry snapshot,
  global v1 manifest, objects. The same Standard/Protected encryption applies to the
  whole bundle.
- `convertV1Bundle(bundle) → canonical` is pure. It's deterministic when the bundle has
  `registryB64`, and falls back to the local registry for pre-Phase-15B bundles that
  lack it.
- Server (`packages/cloud-server/src/memory-service.ts`): reject
  `bundleFormatVersion: 'stack-mem-bundle-v1'` creates once the account's latest is
  v2, with the `@beta` message. `standardProjectCountsFromBundle`
  (`packages/memory/src/remote/project-counts.ts`) reads v2.
- Concurrency uses the existing `expectedParent` check in `createGeneration`
  (`packages/memory/src/remote/backend.ts`).

### A.6 Error codes

`MemorySyncError` codes: `merge-pending`, `cloud-moved-retry-exhausted`,
`case-collision`, `project-unbound`, `migration-invalid` (unresolvable legacy entries
only), `bundle-unsupported`.

### A.7 Existing code this builds on

- Project IDs and registry: `packages/memory/src/project/registry.ts`, `project-id.ts`
- Proven identity resolution: `packages/cli/src/memory/canonical-identity.ts`
- Claude discovery (becomes the adapter's `scan`): `packages/memory/src/claude-adapter.ts`
- Content store and atomic writes: `packages/memory/src/store.ts`
- Bundle codec: `packages/memory/src/remote/bundle-codec.ts`
- Staging and working-tree status: `packages/cli/src/memory/stage-memory.ts`,
  `working-tree-status.ts`

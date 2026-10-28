# Cross-Agent Project Memory (Codex + Cursor) — Design

**Status:** approved design, 2026-10-28. Builds on STAK-native Project Memory
(`2026-10-22-stak-native-project-memory-design.md`) and the Memory lock
(`2026-10-25-memory-lock-design.md`).

## 1. The idea in one paragraph

STAK already keeps each project's Memory in one agent-neutral place, fed today by
Claude Code. This feature writes that same Memory into **Codex** and **Cursor**, so all
three agents start every session knowing the same things about the project. It is
**one-way** (STAK → agent) and **private** (never committed to the repo).

## 2. Decisions (user-approved)

| Question        | Decision                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Direction       | STAK → every enabled agent. Edits in Codex/Cursor's files do not flow back (v1).                            |
| Privacy         | Private to the user. Files STAK writes are kept out of Git via the repo's local-only ignore list.           |
| Codex placement | A STAK-managed `AGENTS.override.md` at the project root = the team's `AGENTS.md` + the STAK Memory section. |
| Content         | Shared notes + private instructions, within a size budget. Agent-specific memory stays with its agent.      |
| When            | Switched on per agent by `stak run codex\|cursor`; then refreshed automatically whenever Memory changes.    |

## 3. Background: how the agents read project memory (checked 2026-10-28)

- **Codex** reads `~/.codex/AGENTS.md`, then, from the repository root down to the
  working directory, one file per directory: `AGENTS.override.md` if present, otherwise
  `AGENTS.md` (or a configured fallback name). Files are concatenated root-first. The
  total is capped at `project_doc_max_bytes` (default 32 KiB); Codex stops reading
  beyond it. There is no include mechanism. Codex's own automatic memories
  (`~/.codex/memories/`) are global across projects and are out of scope.
- **Cursor** loads project rules from `.cursor/rules/*.mdc` (Markdown with YAML
  frontmatter: `description`, `globs`, `alwaysApply`) plus `AGENTS.md`. Cursor removed
  its Memories feature in 2.1; it does not write memory itself.

## 4. What gets written

For every project STAK can locate on this machine (same rules as Memory
materialize: binding, Git candidate, or unambiguous reconstruction) and every
**enabled** agent:

| Agent  | File (inside the project folder)         |
| ------ | ---------------------------------------- |
| Cursor | `.cursor/rules/stak-memory.mdc`          |
| Codex  | `AGENTS.override.md` at the project root |

Claude Code is unchanged (it already has its adapter).

### 4.1 Content (the "Memory section")

Built from the project's canonical Memory (present documents only), in this order:

1. `instructions/private.md` (from `CLAUDE.local.md`)
2. `notes/MEMORY.md` (the notes index), if present
3. every other `notes/**` document, sorted by path

`agents/<agent>/…` documents are never exported to a different agent.

Each document is rendered as a short Markdown heading naming it, followed by its
content. The section starts with one line:
`> Managed by STAK — edit your memory in Claude or with \`stak memory\`, not here.`

### 4.2 Size budget

- **Codex:** the whole `AGENTS.override.md` (team `AGENTS.md` + STAK section) must fit
  in a budget of 30 KiB (default `project_doc_max_bytes` 32 KiB minus a safety margin;
  `~/.codex/AGENTS.md` and nested files also count toward Codex's cap, so the margin is
  deliberate). The team's `AGENTS.md` is always included in full first; if it alone
  exceeds the budget, STAK writes no override for that project and reports why.
- **Cursor:** the STAK section has a fixed budget of 24 KiB.
- If Memory does not fit, items are kept in §4.1 order and **whole documents** are
  dropped from the end (never truncated mid-document). The file ends with:
  `> N notes left out to save space: <paths>.` `stak status` reports it.

### 4.3 File formats

- **Cursor** `.mdc`: YAML frontmatter
  `description: "Project memory from STAK"`, `alwaysApply: true`; then the Memory
  section.
- **Codex** `AGENTS.override.md`: the team's root `AGENTS.md` (if present; line
  endings normalised to LF and trailing blank lines trimmed, so output is stable), then
  a separator line, then the Memory section. Freshness is judged against the hash of
  the team file's raw bytes.

## 5. Privacy: keeping files out of Git

- For a project inside a Git repository, STAK adds each file it writes to the repo's
  local-only exclude list. The path is resolved with `git rev-parse --git-path
info/exclude`, so worktrees and submodules work. Entries are written inside a marked
  block (`# >>> STAK (managed) >>>` … `# <<< STAK <<<`) and are root-anchored
  (`/AGENTS.override.md`, `/.cursor/rules/stak-memory.mdc`).
- If the file is **already tracked** by Git (`git ls-files --error-unmatch`), STAK does
  not write it (an exclude cannot hide a tracked file) and reports it.
- For a project that is not a Git repository, the file is written without an exclude
  (there is nothing to commit to).
- If Git is not available, STAK does not write into Git repositories and reports why
  (it cannot guarantee privacy).

**Mechanics** (implementation-verified):

- Each file gets two root-anchored lines: `/<path from worktree root>` and
  `/<dir>/.<name>.*.tmp` (the temp sibling the atomic write creates first). Paths are
  anchored at the worktree root, with realpath on both sides.
- After adding the lines, STAK confirms with `git check-ignore --no-index` on the file
  and on a sample temp name. If either is not ignored (a `.gitignore` `!` rule wins over
  the exclude), the result is `skipped-not-ignorable`: STAK releases the lines it just
  added and deletes its own unchanged file.
- Any Git exit other than 0 or 1 (for the tracked and ignored checks) means no write.
- A `.git` ancestor where Git cannot read the repository is `skipped-no-git`.
- A line is removed only when no current, retired or private-file record in
  `state.json` for the same exclude file still uses it. Before a temp-pattern line is
  removed, STAK deletes its own leftover `.<name>.<uuid>.tmp` siblings; if one cannot be
  deleted, the line stays.
- STAK's Git calls run without `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_COMMON_DIR` or `GIT_PREFIX`, so the folder STAK names is the repository it
  checks.

### 5.1 Claude's `CLAUDE.local.md`

Materialize writes the project's private instructions (`instructions/private.md`) into
the project folder as Claude's `CLAUDE.local.md`. It gets the same protection, at write
time only (the N/P/C sync decisions are unchanged), inside the materialize step and so
inside the caller's Memory lock:

| Case                                                           | Write                                | Exclude                                              |
| -------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Not a Git repo                                                 | yes                                  | none                                                 |
| Tracked                                                        | yes                                  | none                                                 |
| Already ignored                                                | yes                                  | only missing lines, or lines already in STAK's block |
| Otherwise                                                      | yes, after Git confirms it's ignored | both lines, recorded in `privateFiles`               |
| `!` rule, unusable Git (including safe.directory) or any error | no                                   | release this call's lines                            |

- **On refusal:** the projection is not advanced, so the file stays pending and is
  retried on every sync. It is shown as a materialize warning, and exit codes are
  unchanged. A repository Git refuses (safe.directory / dubious ownership) is told apart
  from Git not being installed; its note gives
  `git config --global --add safe.directory <repo>`.
- **On delete:** the record is dropped and lines no other record uses are released.
- This reads `state.json` even when no agent is enabled. A corrupt file fails closed:
  the warning names `<home>/memory/agent-exports/state.json` and says to move it aside
  (e.g. `state.json.bak`), then run `stak pull` (or `stak memory materialize`).
- **Known limits:** files written before this version are protected only from their
  next write; a later `.gitignore` change is not re-checked for an existing
  `CLAUDE.local.md`; legacy `stak memory restore` is not covered; `.claude/agent-memory/**`
  is not covered.

## 6. Never touch the user's files

- STAK only writes, updates or deletes files it created. It records, per project and
  agent, the path and the SHA-256 of what it last wrote (machine-local state, never
  bundled or pushed).
- **User's own override:** if `AGENTS.override.md` exists and STAK has no record of
  writing it, STAK skips Codex for that project and reports it.
- **Hand edits:** if a STAK file's current content differs from what STAK last wrote,
  STAK does not overwrite it. It reports: move the edit into your real memory, or reset
  the file (`stak memory agents reset <agent>`), which rewrites it.
- The team's `AGENTS.md` and the user's own `.cursor/rules/*` are never modified.
- An unrecorded file that is byte-identical to a fresh render is adopted (a crash
  between writing and recording).
- Records at a project's old folder are kept in `retired`, so those files stay
  excluded: an unchanged one is deleted, a hand-edited one is kept, and the record is
  restored if the project moves back. Record paths are compared case-insensitively on
  Windows, so `C:\` vs `c:\` is not a move.
- When the team's `AGENTS.md` alone is too large, STAK withdraws its own unchanged
  override (it would hide the team file from Codex).
- **One folder per project:** a project located in several folders (for example two
  checkouts of one repository), or a folder claimed by several projects, is skipped with
  a note until `stak project map` settles it. Materialize itself is unchanged.

## 7. Switching on, staying fresh, switching off

- **On:** `stak run codex` / `stak run cursor` enables shared memory for that agent
  (machine-local setting) and writes the files immediately. `--no-memory` skips it.
  `stak memory agents enable <agent>` does the same without running the agent.
- **Fresh:** after any command that changes Memory or materializes it — `stak add .`,
  `stak pull`, `stak push`, `stak memory backup`, `stak memory resolve` (final),
  `stak memory materialize`, `stak memory recover` — STAK regenerates the files for
  every located project and enabled agent, inside the same Memory lock as the command
  (spec 2026-10-25). The Codex file is also regenerated when the team's `AGENTS.md`
  changed (detected by hash of the `AGENTS.md` it was built from).
- **Status:** `stak status` / `stak memory status` show one line per enabled agent:
  up to date, or the count of projects that are out of date / skipped / hand-edited /
  over budget.
- **Off:** `stak memory agents disable <agent>` deletes the files STAK wrote (only if
  unchanged since STAK wrote them), removes their entries from the local exclude list,
  and clears the setting. A **hand-edited** file is left in place and reported, and its
  exclude entry is **kept**, so it can still never be committed by accident (privacy
  wins over cleanup). An exclude entry is only removed when no remaining STAK file
  (e.g. in another worktree of the same repo) still relies on it.
- **List:** `stak memory agents` shows each agent's on/off state.
- **Status states:** out of date (which includes never written), skipped, hand-edited,
  not ignorable (also checked for files STAK already wrote), over budget, and couldn't
  be checked (a Git error is never reported as fine).
- `stak run` waits up to 2 s for the Memory lock, then prints a note and launches.
- `stak memory agents enable|disable|reset` hold the Memory lock; a busy lock fails
  like other `stak memory` commands. The list never takes it.
- Disable removes the agent's setting key.
- `stak memory materialize <project>` refreshes the agent files of every project.

## 8. Errors

Exporting never fails the command that triggered it. Problems are reported as
notes (skipped project, over budget, hand-edited, tracked file, no Git). A write
failure on one project does not stop the others.

- The hand-edited note prints for `stak run`, `memory agents enable|reset|disable` and
  status, not after `add .` / `pull` / `push` and the other refreshes.
- **Corrupt state file:** "Agent memory sharing skipped: STAK's record of the agent
  files it wrote is unreadable. Move `<home>/memory/agent-exports/state.json` aside (for
  example, rename it to state.json.bak), then run `stak memory agents reset <agent>`
  and check `git status` in your projects."
- **Corrupt settings:** "Agent memory sharing skipped: STAK's agent memory settings are
  unreadable. Delete `<home>/memory/agent-exports/settings.json`, then run
  `stak memory agents enable <agent>`."
- `--json` only gains an `agentMemory` field, on `stak status`, `stak memory status`,
  `stak memory backup` and `stak memory recover`. Nothing is removed.

## 9. Out of scope (later)

- Agent → STAK (edits in Codex/Cursor files flowing back).
- Team sharing (committed files).
- Importing Codex's automatic memories.
- Other agents (Windsurf, Copilot, etc.).

## 10. Testing

Unit tests: rendering order and budget, Cursor frontmatter, Codex composition with
and without a team `AGENTS.md`, oversized team `AGENTS.md`, exclude block written
once and removed cleanly (including worktrees), tracked-file refusal, user-owned
override skipped, hand-edit detection, reset, disable cleanup, non-Git project.
CLI tests: `stak run` enables, `--no-memory`, refresh after add/pull/push, status
lines, `memory agents` commands. A manual run on a machine with Codex and Cursor.

Real-Git suites (skipped when `git` is missing): worktrees sharing one exclude file,
submodules, `.gitignore` negation (before and after a write), temp-file exclusion and
crashed temp files, `CLAUDE.local.md` (excluded, already ignored, tracked, negation,
release, worktrees), and the two-machine end-to-end test (A adds and pushes, B pulls
into both agents, `git status` stays clean, edits flow, disable cleans up). CLI
lock-ordering tests use a lock spy to show every export runs between lock and unlock,
after the Memory work, and that the post-command check-in never exports.

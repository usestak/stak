# Cross-Agent Project Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Export each located project's canonical Memory into Codex (`AGENTS.override.md`) and Cursor (`.cursor/rules/stak-memory.mdc`), privately and one-way. Spec: `docs/superpowers/specs/2026-10-28-cross-agent-memory-design.md`.

**Architecture:**
- **@stack/memory** gains a pure renderer and an exporter. The exporter covers file writes, the local Git exclude block, and the machine-local export state.
- **@memstk/cli** wires the exporter in four places:
  - `stak run` turns it on.
  - The refresh runs inside every Memory command's existing locked span.
  - New `stak memory agents` subcommands enable, disable, reset and list it.
  - `stak status` and `stak memory status` show one line per agent.

**Tech:** TypeScript, vitest, `node:child_process` for the `git` calls (follow the existing Git-remote helpers in `packages/memory` and `packages/scanner`).

## Global Constraints
- **Spec rules are binding:**
  - §4 order and budgets: Codex 30 KiB for the whole override file, Cursor 24 KiB for the STAK section. Whole documents only.
  - §5 privacy: `git rev-parse --git-path info/exclude`; a managed block starting `# >>> STAK (managed) >>>` and ending `# <<< STAK <<<`; root-anchored paths; never write a tracked file; with no Git available, don't write into Git repos.
  - §6 never touch user files: SHA-256 of what STAK last wrote; skip a user-owned override; don't overwrite hand edits.
  - §8 errors: exporting never fails the triggering command.
- **Managed line, exact text:** `> Managed by STAK — edit your memory in Claude or with \`stak memory\`, not here.`
- **Over-budget line, exact text:** `> N notes left out to save space: <comma-separated paths>.`
- **Cursor frontmatter, exact text:**
  ```
  ---
  description: "Project memory from STAK"
  alwaysApply: true
  ---
  ```
- **Export state is machine-local:** `<STAK home>/memory/agent-exports/state.json`. Add it to `STATE_EXCLUDE_PATHS` so it never enters any bundle or push.
- **Locking and agents:**
  - All writes happen inside the caller's existing Memory lock.
  - The exporter never takes the lock itself.
  - Agent ids are exactly `codex` and `cursor`.
- **Process:**
  - Run `pnpm -w build` before tests.
  - Run vitest, `tsc --noEmit -p .`, ESLint and `prettier --check` on touched files for every touched package.
  - Commit with explicit paths, never `git add .`. Trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Renderer and exporter in @stack/memory

**Files:**
- Create: `packages/memory/src/agent-export/render.ts` (+ test)
- Create: `packages/memory/src/agent-export/exporter.ts` (+ test)
- Create: `packages/memory/src/agent-export/git-exclude.ts` (+ test)
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/core/src/state.ts` (add `memory/agent-exports` to `STATE_EXCLUDE_PATHS`)

**Produces:**
- `renderAgentMemory(input: { agent: 'codex' | 'cursor'; documents: Array<{ path: string; text: string }>; teamAgentsMd?: string }): { content: string; omitted: string[]; status: 'ok' | 'team-agents-md-too-large' }`
  - Pure; this is where the order and the budget are applied.
  - `documents` holds only the present `notes/**` and `instructions/private.md` documents. The caller filters out `agents/**`.
- `exportProjectMemory(options: { stackHome; projectId; projectDir; agent; documents; readObject?; git?: GitRunner; now? }): Promise<ExportResult>`
  - `ExportResult = { status: 'written' | 'unchanged' | 'skipped-user-file' | 'skipped-hand-edited' | 'skipped-tracked' | 'skipped-no-git' | 'skipped-team-too-large' | 'failed'; path: string; omitted: string[]; message?: string }`
  - Reads the team `AGENTS.md` itself.
  - Applies all the §6 rules, maintains the exclude block, and records state (path, sha256, the `AGENTS.md` hash it was built from, `updatedAt`).
- `removeProjectExport(options: { stackHome; projectId; projectDir; agent; git? }): Promise<{ status: 'removed' | 'kept-hand-edited' | 'none' }>`
  - Deletes STAK's file only if unchanged.
  - Removes STAK's line from the exclude block, and removes the block when it is empty.
- `exportStatus(options: { stackHome; projectId; projectDir; agent }): Promise<'up-to-date' | 'stale' | 'hand-edited' | 'user-file' | 'missing'>`
  - Read-only.
- `readExportSettings(stackHome)` / `writeExportSettings(stackHome, { enabled: { codex?: boolean; cursor?: boolean } })`
  - Stored in `memory/agent-exports/settings.json`.

**Steps (TDD):**
- [ ] Renderer tests:
  - order;
  - managed line;
  - headings;
  - whole-document dropping, with the omitted line;
  - Codex composition with and without a team `AGENTS.md`;
  - a team file that alone exceeds the budget gives `team-agents-md-too-large`;
  - Cursor frontmatter;
  - deterministic output.
- [ ] Git exclude tests, with a real temp Git repo; skip if `git` is missing:
  - the block is written once and is idempotent;
  - the entry is removed, and the block is dropped when it becomes empty;
  - a worktree resolves `--git-path`;
  - the user's own lines are untouched.
- [ ] Exporter tests:
  - written, then unchanged on re-run;
  - a user-owned override is skipped;
  - a hand edit is skipped and not overwritten;
  - a tracked file is skipped;
  - a non-Git project is written with no exclude;
  - a changed team `AGENTS.md` triggers a rewrite and status `stale` before it;
  - remove/disable cleanup;
  - state is never written outside `memory/agent-exports`.
- [ ] Implement, run all checks, then commit.

### Task 2: CLI wiring

**Files:**
- Modify: `packages/cli/src/memory/canonical-ops.ts`
  - Add `exportAgentMemory(stackHome, discovery, { agents? })`. It locates targets via the same `locateMaterializeTargets` and returns per-agent notes.
  - Call it at the end of the locked span of add / pull / push / backup / final resolve / materialize / recover. That is NOT the check-in.
- Modify: `packages/cli/src/commands/run.ts`
  - `stak run codex|cursor` enables the agent and exports, unless `--no-memory`.
  - Use the run command's existing dependency pattern, plus the Memory lock (`stak run` must take the Memory lock around the export only).
- Modify: `packages/cli/src/commands/memory.ts`
  - Add `memory agents` (list), `memory agents enable <agent>`, `disable <agent>` and `reset <agent>`.
  - All of these except the list take the Memory lock, as `stak memory <x>`.
- Modify: `packages/cli/src/ui/*`
  - One status line per enabled agent in `stak status` and `stak memory status`.
  - Concise notes after the commands that export.
- Modify: `docs/memory.md`, `docs/commands.md`, and the web CLI reference data (`apps/web/app/docs/cli/cli-reference.data.ts`) for the new subcommands.

**Steps (TDD):** CLI tests with the existing harness and temp projects:
- [ ] `stak run codex` enables the agent and writes the file; `--no-memory` doesn't.
- [ ] `add .` refreshes the export; `pull` writes Cursor and Codex files for a located project; disabled agents are untouched.
- [ ] Status lines.
- [ ] `memory agents` enable/disable/reset/list.
- [ ] A failed export never changes the exit code.
- [ ] Implement, run all checks (cli + memory + web docs test), then commit.

### Task 3: End-to-end check and docs polish
- [ ] Add an end-to-end test using the real functions:
  - two machines;
  - A has Claude notes, then `add .` and `push`;
  - B has Codex and Cursor enabled, then `pull`;
  - B's project has a local-only `AGENTS.override.md` and `.mdc` containing A's notes, and the files are listed in `.git/info/exclude` and not in `git status`.
- [ ] Update the "Why not Git?" copy line "(coming soon)" only if the owner asks. Do NOT change it here.

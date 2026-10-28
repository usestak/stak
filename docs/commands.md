# Command reference (V0.1)

All mutating commands follow: intent → plan → preview → approval → apply →
result. Mutations require confirmation; pass `--yes` for non-interactive use.
`--yes` never bypasses conflicts, integrity failures, or privacy blocks.

`--json` (where noted) prints exactly one JSON document to stdout and nothing
else. It never contains tokens, secrets, or signed URLs.

## Local (work fully offline)

### `stak scan [--project] [--json]`

Read-only discovery of Skills across agent roots. Never mutates anything.

### `stak init`

Capture the current global Skills as the desired Environment `main`.

### `stak status [--json]` / `stak diff [--json]`

Compare this machine to `main`: satisfied, modified, missing, not installed,
uncertain, untracked, drift. _Missing_ means a Skill was on this machine (captured
by `init`/`add`, or installed by `stak run`) and is now gone; `stak remove` drops
it from `main` if that was deliberate. _Not installed_ means the Skill is in
`main` but was never set up on this machine, which is normal right after
`stak pull` or `stak use`; run `stak run <agent>` to install it. Not
installed Skills are never staged or pushed as removals. When project Memory
sharing is on for Codex or Cursor, `status` adds one line per agent (up to date,
or how many projects are out of date, skipped, hand-edited, not ignorable or over
budget); `--json` adds an `agentMemory` field.

### `stak use <stak> [--dry-run] [--json] [--yes]`

Add a STAK layer to `main`. `<stak>` may be a local path or a public
`@owner/name`. Desired-state only — no agent directories are changed. Remote use
reacquires exact references, verifies hashes, and persists the imported version
locally so subsequent `status`/`diff`/`remove` work offline.

### `stak remove <name|id> [--yes]`

Remove a STAK layer from `main`. Skills still required by other layers are
preserved.

### `stak run <codex|cursor|claude> [--dry-run] [--json] [--yes] [--no-memory]`

Reconcile `main` into an agent's Skill directory, then launch that agent's CLI
with the Skills projected. Verifies the agent is installed first; protects
unmanaged content; removes only healthy STAK-owned bindings. `stak run codex`
launches the **Codex CLI** (`codex` on your `PATH`), not the ChatGPT desktop app.
The launcher is shim-safe: on Windows an npm `.cmd`/`.bat` shim is executed
without a shell and with argument-array semantics preserved (see
[security](./security.md#windows-npm-shims)). `--dry-run` reconciles and previews
without launching; add `--json` for structured output.
`stak run codex` and `stak run cursor` also turn on project Memory sharing for
that agent and write its files before launching (see `stak memory agents`);
`--no-memory` skips this and `--dry-run` writes nothing. Sharing problems are
printed as notes and never stop the launch.

### `stak try <stak> -- codex|claude|cursor [--dry-run] [--json]`

Run a STAK in an isolated scratch Codex, Claude, or Cursor session (temporary
HOME plus a temporary agent config/state directory — `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, or `CURSOR_CONFIG_DIR`). `<stak>` may be local or public.
`main` and normal bindings are untouched. Cursor trials require
authentication: a normal `agent login` session is detected and reused
automatically, or set `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`.

## Memory (private, local)

Private durable agent context — separate from shareable Skills and never
publishable. See [memory](./memory.md).

### `stak memory scan [--json] [--verbose]`

Read-only discovery of portable Claude memory on this machine. Changes nothing.

### `stak memory backup [--json]`

Copy allowlisted memory into STAK's private store (read-only capture; native
Claude files are never modified) and, when signed in, upload it to STAK
Cloud. Commits the manifest last. Now the Memory part of `stak push` (it merges
with Cloud and never overwrites); kept as a deprecated alias.
While its "supersede?" confirmation is waiting for your answer, it holds the
Memory lock, so other Memory commands wait (up to 10 seconds) and then ask you
to try again.

### `stak memory status [--json] [--verbose]`

Show the last memory backup, plus one line per agent with Memory sharing on
(`--json` adds an `agentMemory` field).

### `stak memory recover [--backup <n>] [--passkey] [--recovery-file <path>] [--json]`

Download the private memory store from STAK Cloud onto this machine (requires
sign-in). Use `recover` for explicit or history-based recovery, or when Memory
is Protected; a fresh machine normally gets its Memory from `stak pull`
instead. Recovering an older backup is a rollback: files added since then are
recorded as deletions, and the next `stak push` publishes the rollback as the
newest backup (merged with Cloud like any push; Cloud history is never
rewritten). On a machine that has never synced Memory, push refuses after an
older-backup recover; recover the latest first.

### `stak memory restore [--dry-run] [--json] [--verbose]`

Restore private memory into native agent Memory files. Local only — never
talks to Cloud. Only writes absent targets; a differing existing target is
reported as a conflict and left untouched (never merged).

### `stak memory protect [--passkey] [--recovery-file <path>] [--json]`

Enable client-side encrypted (Protected) Cloud backup, optionally with a
passkey or recovery file.
The `--passkey` flows of `protect` and `recover` hold the Memory lock while they
wait for you in the browser, so finish or cancel them before running other
Memory commands.

### `stak memory history [--json]`

Show your Memory backup history (newest first).

### `stak memory resolve [project] [path] [--keep local|cloud|both]`

Resolve a Memory conflict between machines: keep local, keep cloud, or keep
both. With no arguments, lists the pending conflicts. `<project>` is a Project
ID or a unique prefix of one. Choices take effect when the last conflict is
resolved; then run `stak push`. "Keep both" keeps Cloud's version at the
original name and yours at `<name>.conflict-<hash>.<ext>`.

### `stak memory diff <project> <path>`

Show both versions (local and Cloud) of one pending Memory conflict. The only
command that prints Memory content.

### `stak memory materialize [project] [--agent claude]`

Rebuild agent Memory files from STAK Memory, for every project on this machine
or just one. Never overwrites a file you edited and haven't added yet. Projects
not found on this machine are reported as not available and nothing is written
for them. Only `claude` is supported. In a Git repository, `CLAUDE.local.md`
is kept out of Git with the local `.git/info/exclude` before it is written; one
a `.gitignore` rule re-includes is not written, with a note.

### `stak memory agents [--json]`

Share project Memory (notes and private instructions) with Codex and Cursor,
one-way and private. With no subcommand, lists each agent (on or off), a short
status, and what to do for each project that needs it. Codex gets
`AGENTS.override.md` (your team's `AGENTS.md` plus the STAK Memory section),
Cursor gets `.cursor/rules/stak-memory.mdc`. In a Git repository both are added
to the local `.git/info/exclude` first, so they are never committed. Once an
agent is on, its files are refreshed after `stak add .`, `pull`, `push`,
`memory backup`, the final `memory resolve`, `memory materialize` and
`memory recover`. Sharing problems are printed as notes and never fail a
command. See [memory](./memory.md#sharing-memory-with-codex-and-cursor).

- `stak memory agents enable <codex|cursor>` — turn sharing on and write the
  files now (`stak run codex|cursor` does this too).
- `stak memory agents disable <codex|cursor>` — turn sharing off and delete the
  files STAK wrote, if unchanged. A hand-edited file is kept and stays excluded
  from Git.
- `stak memory agents reset <codex|cursor>` — rewrite STAK's files for that
  agent, including ones edited by hand. Never touches a file STAK didn't write.

`enable`, `disable` and `reset` hold the Memory lock; the list never does.

### `stak memory unlock [--force]`

Remove a leftover Memory lock left behind by a crashed STAK command. Shows which
command held it and when it started. Removes it if that process is no longer
running; refuses if it may still be running. `--force` removes it anyway, after
a warning: doing this while a real STAK command is running can lose its Memory
changes. Says so, and succeeds, when no lock is held. Leftover locks normally
clear themselves; this is the manual fallback.

Memory is captured from Claude Code; Codex and Cursor receive project Memory
through `stak memory agents`.

## Project

Logical projects are derived from recovered Memory. `stak project` reviews
them and maps recovered Memory to a directory on this machine; lifecycle
(`active`/`archived`) is independent of whether a project is currently
available on this machine.

### `stak project` / `stak project list [--json]`

List logical projects STAK knows about (read-only). `list` is the default
subcommand, so `stak project` on its own is equivalent to `stak project list`.

### `stak project map <project> <directory> [--json] [-y|--yes]`

Authorize a local directory as the restore destination for a project. This is
a local binding only; the path is never shared as project identity. Refused
when the directory belongs to a different repository (`git-conflict`) or
already belongs to another logical project (`identity-conflict`). Prompts for
confirmation unless `--yes` (or `--json`) is passed.

### `stak project name <project> <name> [--json]`

Set a logical project's display name. Presentation metadata only — it never
changes the Project ID, mapping, or restore behavior. Refused for
Git-identified projects (whose name _is_ their Git identity), and for empty,
too-long (200 characters max), or path-like names.

### `stak project archive <project> [--json] [-y|--yes]`

Archive a project without deleting its identity or Memory (reversible).
Prompts for confirmation unless `--yes` (or `--json`) is passed. Mirrors the
lifecycle change to STAK Cloud when signed in; if offline or unreachable it
reports the propagation failure so you can re-run once connected.

### `stak project unarchive <project> [--json]`

Return an archived project to active. Non-destructive, so it proceeds without
a confirmation prompt. Mirrors the lifecycle change to STAK Cloud the same way
`archive` does.

## Skill

Manage the Skill lifecycle on this machine. `update` changes installed
machine state (and checks in on success); `pause`/`resume` change only
machine-local desired state — the projection effect is realised on the next
`run` or `skill update`; `check` only contacts each checkable Skill's source
remote and reports the result to Cloud, and never approves, installs, pauses,
or resumes anything.

### `stak skill update [skill] [--json]`

Install approved Skill versions on this machine. With no `[skill]` selector,
reconciles every Skill across every detected agent (Codex, Claude Code,
Cursor); with a selector, narrows to that Skill's stable id.

### `stak skill pause <skill> [--json]`

Stop projecting a Skill to agents (keeps its version and provenance). Your
agent files are unchanged until you reconcile this machine — run `stak run`
or `stak skill update` to apply it.

### `stak skill resume <skill> [--json]`

Project a paused Skill to agents again. Like `pause`, the change is
desired-state only until the next `run` or `skill update`.

### `stak skill check [skill] [--json]`

Check Skill sources for updates. Contacts each checkable Skill's source
remote and reports the result to STAK Cloud; requires `stak login`. Never
approves, installs, pauses, or resumes anything.

## Cloud

Require `STAK_API_URL`; mutations require `stak login`.

### `stak login [--api-url <url>] [--label <label>] [--no-browser]`

Browser device-authorization flow; stores an opaque token under
`$STAK_HOME/auth.json`.

### `stak logout`

Revoke the server token where reachable and remove the local credential.

### `stak whoami [--json]`

Show the signed-in account. Never prints the token.

### `stak push [--dry-run] [--json] [--yes]`

Back up the private portable `main` Environment. Optimistic conflict protection;
no-op when unchanged. Does not change agent bindings.

### `stak pull [--dry-run] [--json] [--yes]`

Reconstruct `main` on this machine (reference reacquisition + private snapshot
download, all verified, then an atomic commit). Does not change agent bindings:
the pulled Skills show as _not installed here yet_ in `stak status` until
`stak run <agent>` installs them.

### `stak publish <stak> [--slug <slug>] [--dry-run] [--json] [--yes]`

Publish a public STAK as `@owner/name` from a local source or an
active local layer.

### `stak open [--print]`

Open the STAK web app's Overview with this machine selected
(`…/overview?machine=<machineId>`). The machine id is the only thing in the
URL — no token, secret, or Memory is ever included. Makes no network call of
its own (web sign-in is handled by the browser) and mutates nothing. Pass
`--print` to print the URL instead of launching a browser.

## CLI updates

### `stak upgrade [--dry-run] [-y|--yes]`

Update the CLI to the newest version on your channel: a prerelease build
(such as `0.2.0-beta.3`) follows the npm `beta` dist-tag, a release follows
`latest`. Checks the registry directly, prints the current and latest
versions, and exits 0 if you are already up to date. Otherwise it detects
whether the CLI was installed with npm or pnpm, shows the exact command
(`npm i -g @memstk/cli@<channel>` or `pnpm add -g @memstk/cli@<channel>`;
npm when it cannot tell), and asks before running it. `--yes` skips the
prompt; `--dry-run` prints the command and changes nothing. If the install
fails, the command is printed so you can run it yourself (from an
administrator or `sudo` shell for a permissions error).

**Update reminder.** At most once every 24 hours, other commands look up the
newest version on your channel (honouring `npm_config_registry`) and cache
the answer in `update-check.json` under `STAK_HOME`. When a newer version
exists, one line is printed to stderr after the command's output, at most
once a day per version. The lookup never delays a command by more than about
a second and never changes its output or exit code; any failure — including
a registry that never answers — is silent and backs off for an hour before
the next attempt.
It stays quiet when stderr is not a TTY, when `CI` is set, with `--json`,
`--version` or `--help`, for `stak upgrade` itself, and when
`STAK_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER` is set.

## Current V0.1 restrictions

- One persistent Environment: `main` only. `stak switch` is deferred.
- Isolated `try` supports Codex, Claude, and Cursor.
- Public STAKs publish every Skill as an immutable, content-addressed
  snapshot — regardless of whether that Skill's own private restoration is a
  snapshot or a Git reference. Its content must already be in STAK Cloud: run
  `stak push`, then publish (or try again if publishing says upload is
  required).
- No automatic STAK updates; an already-active public STAK is not silently
  upgraded.
- No force override for conflicts (`--force` does not exist); conflicts block
  conservatively.

## Exit codes

- `0` — success
- `1` — operational failure, validation/usage error, or a conflict requiring
  user action (typed errors carry a machine-readable `code`; see
  [troubleshooting.md](troubleshooting.md))

Non-TTY invocations of mutating commands without `--yes` decline safely rather
than hang.

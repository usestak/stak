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

Compare this machine to `main`: satisfied, modified, missing, uncertain,
untracked, drift.

### `stak use <stak> [--dry-run] [--json] [--yes]`

Add a STAK layer to `main`. `<stak>` may be a local path or a public
`@owner/name`. Desired-state only — no agent directories are changed. Remote use
reacquires exact references, verifies hashes, and persists the imported version
locally so subsequent `status`/`diff`/`remove` work offline.

### `stak remove <name|id> [--yes]`

Remove a STAK layer from `main`. Skills still required by other layers are
preserved.

### `stak run <codex|cursor|claude> [--dry-run] [--json] [--yes]`

Reconcile `main` into an agent's Skill directory, then launch that agent's CLI
with the Skills projected. Verifies the agent is installed first; protects
unmanaged content; removes only healthy STAK-owned bindings. `stak run codex`
launches the **Codex CLI** (`codex` on your `PATH`), not the ChatGPT desktop app.
The launcher is shim-safe: on Windows an npm `.cmd`/`.bat` shim is executed
without a shell and with argument-array semantics preserved (see
[security](./security.md#windows-npm-shims)). `--dry-run` reconciles and previews
without launching; add `--json` for structured output.

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
Cloud. Commits the manifest last.

### `stak memory status [--json] [--verbose]`

Show the last memory backup.

### `stak memory recover [--backup <n>] [--passkey] [--recovery-file <path>] [--json]`

Download the private memory store from STAK Cloud onto this machine (requires
sign-in). This is the step that populates a fresh machine before `restore` has
anything local to use.

### `stak memory restore [--dry-run] [--json] [--verbose]`

Restore private memory into native agent Memory files. Local only — never
talks to Cloud. Only writes absent targets; a differing existing target is
reported as a conflict and left untouched (never merged).

### `stak memory protect [--passkey] [--recovery-file <path>] [--json]`

Enable client-side encrypted (Protected) Cloud backup, optionally with a
passkey or recovery file.

### `stak memory history [--json]`

Show your Memory backup history (newest first).

Memory is currently scoped to Claude Code; Codex and Cursor memory support is
planned.

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
download, all verified, then an atomic commit). Does not change agent bindings.

### `stak publish <stak> [--slug <slug>] [--dry-run] [--json] [--yes]`

Publish a public STAK as `@owner/name` from a local source or an
active local layer.

### `stak open [--print]`

Open the STAK web app's Overview with this machine selected
(`…/overview?machine=<machineId>`). The machine id is the only thing in the
URL — no token, secret, or Memory is ever included. Makes no network call of
its own (web sign-in is handled by the browser) and mutates nothing. Pass
`--print` to print the URL instead of launching a browser.

## Current V0.1 restrictions

- One persistent Environment: `main` only. `stak switch` is deferred.
- Isolated `try` supports Codex, Claude, and Cursor.
- Public STAKs publish every Skill as an immutable, content-addressed
  snapshot (snapshot-backed Skills can be published; the content must have
  been pushed first).
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

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
`CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` to be set (interactive `agent login`
sessions can't be safely isolated).

## Memory (private, local)

Private durable agent context — separate from shareable Skills and never
publishable. See [memory](./memory.md).

### `stak memory scan [--json] [--verbose]`

Read-only discovery of portable Claude memory on this machine. Changes nothing.

### `stak memory backup [--json]`

Copy allowlisted memory into STAK's private store (read-only capture; native
Claude files are never modified). Commits the manifest last.

### `stak memory status [--json] [--verbose]`

Show the last memory backup.

### `stak memory restore [--dry-run] [--json] [--verbose]`

Restore private memory. Only writes absent targets; a differing existing target
is reported as a conflict and left untouched (never merged). Not uploaded to
Cloud in V0.1.

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

Publish a reference-only public STAK as `@owner/name` from a local source or an
active local layer.

## Current V0.1 restrictions

- One persistent Environment: `main` only. `stak switch` is deferred.
- Isolated `try` supports Codex, Claude, and Cursor.
- Public STAKs are reference-only (snapshot-backed Skills cannot be published).
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

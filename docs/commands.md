# Command reference (V0.1)

All mutating commands follow: intent → plan → preview → approval → apply →
result. Mutations require confirmation; pass `--yes` for non-interactive use.
`--yes` never bypasses conflicts, integrity failures, or privacy blocks.

`--json` (where noted) prints exactly one JSON document to stdout and nothing
else. It never contains tokens, secrets, or signed URLs.

## Local (work fully offline)

### `stack scan [--project] [--json]`

Read-only discovery of Skills across agent roots. Never mutates anything.

### `stack init`

Capture the current global Skills as the desired Environment `main`.

### `stack status [--json]` / `stack diff [--json]`

Compare this machine to `main`: satisfied, modified, missing, uncertain,
untracked, drift.

### `stack use <stack> [--dry-run] [--json] [--yes]`

Add a Stack layer to `main`. `<stack>` may be a local path or a public
`@owner/name`. Desired-state only — no agent directories are changed. Remote use
reacquires exact references, verifies hashes, and persists the imported version
locally so subsequent `status`/`diff`/`remove` work offline.

### `stack remove <name|id> [--yes]`

Remove a Stack layer from `main`. Skills still required by other layers are
preserved.

### `stack run <codex|cursor|claude> [--dry-run] [--json] [--yes]`

Reconcile `main` into an agent's Skill directory. Verifies the agent is installed
first; protects unmanaged content; removes only healthy Stack-owned bindings.

### `stack try <stack> -- codex [--dry-run] [--json]`

Run a Stack in an isolated scratch Codex session (temporary HOME/`CODEX_HOME`).
`<stack>` may be local or public. `main` and normal bindings are untouched.
Isolated `try` is Codex-only in V0.1.

## Cloud

Require `STACK_API_URL`; mutations require `stack login`.

### `stack login [--api-url <url>] [--label <label>] [--no-browser]`

Browser device-authorization flow; stores an opaque token under
`$STACK_HOME/auth.json`.

### `stack logout`

Revoke the server token where reachable and remove the local credential.

### `stack whoami [--json]`

Show the signed-in account. Never prints the token.

### `stack push [--dry-run] [--json] [--yes]`

Back up the private portable `main` Environment. Optimistic conflict protection;
no-op when unchanged. Does not change agent bindings.

### `stack pull [--dry-run] [--json] [--yes]`

Reconstruct `main` on this machine (reference reacquisition + private snapshot
download, all verified, then an atomic commit). Does not change agent bindings.

### `stack publish <stack> [--slug <slug>] [--dry-run] [--json] [--yes]`

Publish a reference-only public Stack as `@owner/name` from a local source or an
active local layer.

## Current V0.1 restrictions

- One persistent Environment: `main` only. `stack switch` is deferred.
- Isolated `try` supports Codex only.
- Public Stacks are reference-only (snapshot-backed Skills cannot be published).
- No automatic Stack updates; an already-active public Stack is not silently
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

# Getting started

## Requirements

- Node.js 22+
- Git (for reference-backed Skills and publishing)
- One or more agents installed for `stak run`: Codex, Cursor (`agent` /
  `cursor-agent`), or Claude Code (`claude`)

## Install (Public Beta)

```bash
npm install -g @memstk/cli@beta
stak login
stak init
stak status
```

`npm install -g @memstk/cli@beta` installs the Public Beta — npm's `latest`
tag intentionally still points at `0.1.2`. Building from source remains
possible for contributors; see `CONTRIBUTING.md`.

## Your first Environment

```bash
stak init               # create the desired Environment "main"
stak status             # compare this machine against main
stak diff               # detailed per-Skill differences
```

Optional diagnostic: `stak scan` is read-only discovery across agent Skill
roots — not required before `init`.

`scan`, `init`, `status`, and `diff` never modify agent directories.

## Everyday workflow

```bash
stak status
stak add .
stak push
```

## Compose and project

```bash
stak use ./frontend-stak      # add a local STAK layer to main (desired only)
stak run codex                # project main into Codex's Skill directory
stak run cursor
stak run claude
stak remove frontend          # drop a layer (shared Skills are preserved)
```

`stak run` reconciles bindings only after verifying the agent is installed and
never overwrites unmanaged content. `stak run codex` then launches the **Codex
CLI** (the `codex` command on your `PATH`) with your Skills projected — it does
not open the ChatGPT desktop app. On Windows the CLI is commonly an npm `.cmd`
shim; STAK launches it safely without a shell (see
[security](./security.md#windows-npm-shims)). `stak run cursor` and
`stak run claude` behave the same for the Cursor Agent and Claude Code CLIs.

## Try before you adopt

```bash
stak try ./some-stak -- codex
```

Runs the STAK in an isolated scratch workspace with a temporary HOME and a
temporary agent config/state directory (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or
`CURSOR_CONFIG_DIR`). `main` and your normal bindings are untouched. Isolated
`try` supports Codex, Claude, and Cursor — swap the agent after `--`
(`stak try ./some-stak -- claude`, `stak try ./some-stak -- cursor`).

## Across machines

```bash
stak login            # browser device authorization
stak push             # synchronize staged main (Skills + Memory) to STAK Cloud
# ... on another machine ...
stak login
stak pull             # reconstruct main with matching Skill hashes
stak status           # verify what landed
stak run codex        # then project it into agents
```

## Share a STAK publicly

```bash
stak publish ./frontend-stak      # -> @you/frontend (content-addressed snapshot)
# others:
stak use @you/frontend
stak try @you/frontend -- codex
```

Cloud commands need `STAK_API_URL` (and login for mutations). Local commands
work fully offline. See [cloud-setup.md](cloud-setup.md) and
[commands.md](commands.md).

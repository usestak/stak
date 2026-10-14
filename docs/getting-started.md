# Getting started

## Requirements

- Node.js 22+
- Git (for reference-backed Skills and publishing)
- One or more agents installed for `stak run`: Codex, Cursor (`agent` /
  `cursor-agent`), or Claude Code (`claude`)

## Install (V0.1 from source)

```bash
git clone https://github.com/usestak/stak.git
cd stak
corepack enable          # provides the pinned pnpm
pnpm install --frozen-lockfile
pnpm build
```

The CLI entry point is `packages/cli/dist/bin.js`. For convenience you can link
it locally:

```bash
node packages/cli/dist/bin.js --help
# or, from packages/cli:  npm link   (installs the `stak` binary)
```

> The public npm package name is being finalized. `npx stack` runs an unrelated
> package and is **not** Memory STAK. Installation via `npm install -g @memstk/cli`
> will be documented once the name is chosen (see the release checklist).

## Your first Environment

```bash
stak scan               # read-only discovery across agent Skill roots
stak init               # create the desired Environment "main"
stak status             # compare this machine against main
stak diff               # detailed per-Skill differences
```

`scan`, `init`, `status`, and `diff` never modify agent directories.

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

Runs the STAK in an isolated scratch workspace with a temporary HOME and
`CODEX_HOME`. `main` and your normal bindings are untouched. Isolated `try` is
Codex-only in V0.1.

## Across machines

```bash
stak login            # browser device authorization
stak push             # back up main (private) to STAK Cloud
# ... on another machine ...
stak login
stak pull             # reconstruct main with matching Skill hashes
stak run codex        # then project it into agents
```

## Share a STAK publicly

```bash
stak publish ./frontend-stak      # -> @you/frontend (reference-only)
# others:
stak use @you/frontend
stak try @you/frontend -- codex
```

Cloud commands need `STAK_API_URL` (and login for mutations). Local commands
work fully offline. See [cloud-setup.md](cloud-setup.md) and
[commands.md](commands.md).

# Getting started

## Requirements

- Node.js 22+
- Git (for reference-backed Skills and publishing)
- One or more agents installed for `stack run`: Codex, Cursor (`agent` /
  `cursor-agent`), or Claude Code (`claude`)

## Install (V0.1 from source)

```bash
git clone <this-repo>
cd stack
corepack enable          # provides the pinned pnpm
pnpm install --frozen-lockfile
pnpm build
```

The CLI entry point is `packages/cli/dist/bin.js`. For convenience you can link
it locally:

```bash
node packages/cli/dist/bin.js --help
# or, from packages/cli:  npm link   (installs the `stack` binary)
```

> The public npm package name is being finalized. `npx stack` runs an unrelated
> package and is **not** Stack. Installation via `npm install -g <package-name>`
> will be documented once the name is chosen (see the release checklist).

## Your first Environment

```bash
stack scan               # read-only discovery across agent Skill roots
stack init               # create the desired Environment "main"
stack status             # compare this machine against main
stack diff               # detailed per-Skill differences
```

`scan`, `init`, `status`, and `diff` never modify agent directories.

## Compose and project

```bash
stack use ./frontend-stack     # add a local Stack layer to main (desired only)
stack run codex                # project main into Codex's Skill directory
stack run cursor
stack run claude
stack remove frontend          # drop a layer (shared Skills are preserved)
```

`stack run` reconciles bindings only after verifying the agent is installed and
never overwrites unmanaged content.

## Try before you adopt

```bash
stack try ./some-stack -- codex
```

Runs the Stack in an isolated scratch workspace with a temporary HOME and
`CODEX_HOME`. `main` and your normal bindings are untouched. Isolated `try` is
Codex-only in V0.1.

## Across machines

```bash
stack login            # browser device authorization
stack push             # back up main (private) to Stack Cloud
# ... on another machine ...
stack login
stack pull             # reconstruct main with matching Skill hashes
stack run codex        # then project it into agents
```

## Share a Stack publicly

```bash
stack publish ./frontend-stack     # -> @you/frontend (reference-only)
# others:
stack use @you/frontend
stack try @you/frontend -- codex
```

Cloud commands need `STACK_API_URL` (and login for mutations). Local commands
work fully offline. See [cloud-setup.md](cloud-setup.md) and
[commands.md](commands.md).

# Stack

**The control plane for portable AI agent environments.**

Stack discovers the Agent Skills you have accumulated across Codex, Cursor, and
Claude Code, captures them as a portable **Environment**, restores them on any
machine, safely composes additional **Stacks**, and lets you try someone else's
Stack without disturbing your existing setup.

> Status: V0.1 release candidate. See [docs/release-checklist.md](docs/release-checklist.md)
> for the remaining human release steps.

## Why Stack

Agent Skills accumulate in vendor directories (`~/.agents/skills`,
`~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`). They drift between
machines, get lost on a laptop swap, and are hard to share safely. Stack keeps a
single canonical, content-addressed record of your desired setup and projects it
into each agent's directory — without ever overwriting content it does not own.

## Concepts in one breath

- **Skill** — an existing Agent Skill directory (a `SKILL.md` plus its files).
- **Stack** — a reusable, named collection of Skill requirements.
- **Environment** — your desired local setup. V0.1 has one: `main`.
- **Machine** — a computer with its own bindings and placements; Machine state
  is never uploaded.

See [docs/concepts.md](docs/concepts.md) for the full model.

## Install

Stack is distributed as a single self-contained CLI. During the V0.1 release
candidate the public npm package name is still being finalized (the name `stack`
on npm belongs to an unrelated project), so install from source:

```bash
git clone <this-repo>
cd stack
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.js --help
```

The published package will install the `stack` binary via
`npm install -g <package-name>` once the public name is chosen. `npx stack` is
**not** this project. See [docs/getting-started.md](docs/getting-started.md).

## First five minutes

```bash
stack scan      # discover Skills across your agents (read-only)
stack init      # capture the desired Environment: main
stack status    # see how this machine compares to main
```

Then compose and project:

```bash
stack use ./frontend-stack     # add a local Stack to main
stack run codex                # reconcile main into Codex's Skill directory
stack try ./other-stack -- codex   # try a Stack in an isolated Codex session
```

And carry it across machines or share it:

```bash
stack login
stack push                     # back up main to Stack Cloud (private)
stack pull                     # restore main on another machine
stack publish ./frontend-stack # publish a reusable public @owner/name Stack
```

Full reference: [docs/commands.md](docs/commands.md).

## Safety, at a glance

- Read-only discovery; unmanaged content is never overwritten without approval.
- Content is content-addressed and hash-verified on every restore.
- Trials run in an isolated scratch workspace with a temporary HOME.
- Git references restore the exact revision and hash (`shell:false`, no shell
  interpolation).
- Private snapshots stay private; public Stacks are reference-only.

See [docs/security.md](docs/security.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [Command reference](docs/commands.md)
- [Cloud setup](docs/cloud-setup.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](docs/contributing.md)

## License

No license file has been added yet; see [docs/release-checklist.md](docs/release-checklist.md).
This is a release blocker requiring an owner decision.

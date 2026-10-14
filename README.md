# Memory STAK

**The control plane for portable AI agent environments.**

Memory STAK discovers the Agent Skills you have accumulated across Codex, Cursor, and
Claude Code, captures them as a portable **Environment**, restores them on any
machine, safely composes additional **stacks**, backs up your private agent
**Memory**, and lets you try someone else's stack without disturbing your
existing setup.

> Your STAK should survive your laptop. Your skills, your memory, your setup —
> any agent, any machine.

> Status: 0.1.0 release candidate. See [docs/release-checklist.md](docs/release-checklist.md)
> for the remaining human release steps.

## Why STAK

Agent Skills accumulate in vendor directories (`~/.agents/skills`,
`~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`). They drift between
machines, get lost on a laptop swap, and are hard to share safely. STAK keeps a
single canonical, content-addressed record of your desired setup and projects it
into each agent's directory — without ever overwriting content it does not own.

## Concepts in one breath

- **Skill** — an existing Agent Skill directory (a `SKILL.md` plus its files).
- **stack** — a reusable, named collection of Skill requirements (defined by a
  `stack.yaml`). The product is STAK; the thing you compose is a stack.
- **Environment** — your desired local setup. V0.1 has one: `main`.
- **Machine** — a computer with its own bindings and placements; Machine state
  is never uploaded.

See [docs/concepts.md](docs/concepts.md) for the full model.

## Install

STAK is distributed as a single self-contained CLI. During the 0.1.0 release
candidate the public package `@usestak/cli` is **not yet published to npm**, so
install from source:

```bash
git clone https://github.com/usestak/stak.git
cd stak
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.js --help
```

Once 0.1.0 is published, the package will install the `stak` command via
`npm install -g @usestak/cli`. (`npx stack` is an unrelated project.) See
[docs/getting-started.md](docs/getting-started.md).

## First five minutes

```bash
stak scan      # discover Skills across your agents (read-only)
stak init      # capture the desired Environment: main
stak status    # see how this machine compares to main
```

Then compose and project:

```bash
stak use ./frontend-stack       # add a local stack to main
stak run codex                  # reconcile main into Codex's Skill directory
stak try ./other-stack -- codex # try a stack in an isolated Codex session
```

And carry it across machines or share it:

```bash
stak login
stak push                       # back up main to STAK Cloud (private)
stak pull                       # restore main on another machine
stak publish ./frontend-stack   # publish a reusable public @owner/name stack
```

Full reference: [docs/commands.md](docs/commands.md).

## Safety, at a glance

- Read-only discovery; unmanaged content is never overwritten without approval.
- Content is content-addressed and hash-verified on every restore.
- Trials run in an isolated scratch workspace with a temporary HOME.
- Git references restore the exact revision and hash (`shell:false`, no shell
  interpolation).
- Private snapshots stay private; public stacks are reference-only.

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

MIT — see [LICENSE](LICENSE).

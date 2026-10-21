# @memstk/cli

Public Beta · v0.2.0-beta.2.

**STAK — the control plane for portable AI agent environments.**

STAK discovers the Agent Skills you have accumulated across Codex, Cursor, and
Claude Code, captures them as a portable environment, restores them on any
machine, safely composes additional stacks, backs up your private agent Memory,
and lets you try someone else's stack without disturbing your setup.

## Install

```bash
npm install -g @memstk/cli@beta
```

The package installs a single self-contained `stak` command (no runtime
dependencies).

## The everyday workflow

STAK works like Git:

```
MACHINE  →  stak add  →  MAIN  →  stak push  →  STAK CLOUD
```

- **MACHINE** is whatever Skills/Memory/Projects physically exist on this computer.
- **MAIN** is what you've deliberately chosen as your STAK.
- **STAK CLOUD** is the last version of main you intentionally synced.

There's no separate `stak commit` — `stak push` creates the Cloud checkpoint
automatically.

```bash
stak status               # machine vs. main vs. Cloud — no scan needed first
stak add <skill>          # stage an untracked or modified Skill into main
stak add .                # stage everything eligible: Skills, Memory, Projects
stak push                 # sync main (Skills + Memory) to STAK Cloud
```

On a new machine:

```bash
stak login
stak pull                 # restore Skills + Memory + Projects from STAK Cloud
stak status               # verify what landed
stak run claude
```

## Other commands

```bash
stak scan                 # diagnostic Skill discovery (status already runs this)
stak init                 # bootstrap `main` from everything currently installed
stak diff                 # explain exactly what changed, in detail
stak use <stak>           # adopt a local or public (@owner/name) STAK into main
                           # (no separate `add` needed; `push` still required to sync)
stak remove <skill|stak>  # deliberately drop a Skill or STAK layer from main
stak run codex            # project main into an agent and launch it
stak try <stak> -- codex  # try a STAK in an isolated scratch session, main untouched
stak login                # sign in to STAK Cloud
stak memory backup        # back up private agent Memory directly (Standard or Protected)
stak project              # review logical projects and map recovered memory
stak skill update         # install approved Skill versions on this machine
stak open                 # open the STAK web app with this machine selected
```

Run `stak --help` or `stak <command> --help` for details.

See the full CLI reference: https://www.memstk.com/docs/cli

## Links

- Repository: https://github.com/usestak/stak
- Issues: https://github.com/usestak/stak/issues
- License: MIT
